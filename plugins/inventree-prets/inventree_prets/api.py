"""API du plugin : serializers et endpoints pour la Scannette.

Les vues heritent de l'authentification par defaut de DRF configuree
par InvenTree (token, session, basic), donc le token de la Scannette
passe sans configuration supplementaire.
"""

import datetime
import re

from django.contrib.auth import get_user_model
from django.db.models import Q
from django.http import HttpResponseRedirect
from django.utils import timezone
from django.utils.translation import gettext as _

from rest_framework import serializers, status
from rest_framework.generics import ListAPIView
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from stock.models import StockItem

from .models import Loan, Reservation, slot_label, user_date_fmts


def is_prets_admin(user):
    """Les admins (staff ou superuser) peuvent tout rendre / tout annuler."""
    return bool(user and (user.is_staff or user.is_superuser))


class LoanSerializer(serializers.ModelSerializer):
    """Serializer du modele Loan."""

    serial = serializers.CharField(source="stock_item.serial", read_only=True)
    borrower_label = serializers.CharField(read_only=True)
    is_active = serializers.BooleanField(read_only=True)
    is_overdue = serializers.BooleanField(read_only=True)
    lent_by_detail = serializers.SerializerMethodField()
    returned_by_detail = serializers.SerializerMethodField()
    item_label = serializers.SerializerMethodField()
    can_return = serializers.SerializerMethodField()

    # ISO-8601 avec fuseau (le format DRF global d'InvenTree est '%Y-%m-%d %H:%M'
    # sans offset, en UTC serveur) : le navigateur convertit ainsi dans l'heure
    # locale de chaque utilisateur.
    lent_at = serializers.DateTimeField(read_only=True, format="iso-8601")
    returned_at = serializers.DateTimeField(read_only=True, format="iso-8601")

    class Meta:
        """Champs exposes."""

        model = Loan
        fields = [
            "pk",
            "stock_item",
            "serial",
            "borrower_user",
            "borrower_name",
            "borrower_label",
            "lent_at",
            "due_on",
            "returned_at",
            "is_active",
            "is_overdue",
            "notes",
            "on_behalf",
            "lent_by_detail",
            "returned_by_detail",
            "item_label",
            "can_return",
        ]

    def get_can_return(self, obj):
        """Le retour est reserve a l'EMPRUNTEUR, a qui a enregistre le pret, et
        aux admins. L'emprunteur en fait partie meme quand un admin a confirme
        le pret A SON NOM (lent_by = admin) : il ne doit jamais etre bloque."""
        request = self.context.get("request")
        if not request or not request.user or not request.user.is_authenticated:
            return False
        return (
            is_prets_admin(request.user)
            or obj.lent_by_id == request.user.pk
            or obj.borrower_user_id == request.user.pk
        )

    def get_lent_by_detail(self, obj):
        """Qui a enregistre le pret (meme forme que user_detail du tracking).
        Le pk permet aux fronts d'afficher « Emprunt/Retour enregistre par »
        seulement quand l'auteur n'est pas l'emprunteur."""
        return self._user_detail(obj.lent_by)

    def get_returned_by_detail(self, obj):
        """Qui a enregistre le retour (meme forme que lent_by_detail)."""
        return self._user_detail(obj.returned_by)

    @staticmethod
    def _user_detail(user):
        if not user:
            return None
        return {
            "pk": user.pk,
            "username": user.username,
            "first_name": user.first_name,
            "last_name": user.last_name,
        }

    def get_item_label(self, obj):
        """Libelle lisible de l'objet (pour le widget dashboard)."""
        item = obj.stock_item
        label = item.part.full_name if item.part else f"Objet #{item.pk}"
        if item.serial:
            label += f" # {item.serial}"
        return label


class ReservationSerializer(serializers.ModelSerializer):
    """Serializer du modele Reservation."""

    serial = serializers.CharField(source="stock_item.serial", read_only=True)
    reserved_for_label = serializers.CharField(read_only=True)
    is_active = serializers.BooleanField(read_only=True)
    is_current = serializers.BooleanField(read_only=True)
    is_cancelled = serializers.BooleanField(read_only=True)
    is_fulfilled = serializers.BooleanField(read_only=True)
    created_by_detail = serializers.SerializerMethodField()
    can_cancel = serializers.SerializerMethodField()
    item_label = serializers.SerializerMethodField()

    created_at = serializers.DateTimeField(read_only=True, format="iso-8601")
    cancelled_at = serializers.DateTimeField(read_only=True, format="iso-8601")

    class Meta:
        """Champs exposes."""

        model = Reservation
        fields = [
            "pk",
            "stock_item",
            "serial",
            "reserved_for_user",
            "reserved_for_name",
            "reserved_for_label",
            "start_date",
            "end_date",
            "notes",
            "on_behalf",
            "created_at",
            "cancelled_at",
            "loan",
            "is_active",
            "is_current",
            "is_cancelled",
            "is_fulfilled",
            "created_by_detail",
            "can_cancel",
            "item_label",
        ]

    def get_item_label(self, obj):
        """Libelle lisible de l'objet (pour le widget dashboard)."""
        item = obj.stock_item
        label = item.part.full_name if item.part else f"Objet #{item.pk}"
        if item.serial:
            label += f" # {item.serial}"
        return label

    def get_can_cancel(self, obj):
        """L'annulation est reservee a qui a cree la reservation, et aux admins."""
        request = self.context.get("request")
        if not request or not request.user or not request.user.is_authenticated:
            return False
        return is_prets_admin(request.user) or obj.created_by_id == request.user.pk

    def get_created_by_detail(self, obj):
        """Qui a enregistre la reservation (meme forme que pour Loan)."""
        user = obj.created_by
        if not user:
            return None
        return {
            "username": user.username,
            "first_name": user.first_name,
            "last_name": user.last_name,
        }


def active_reservations(item_pk):
    """Reservations actives d'un objet : ni annulees, ni honorees, ni expirees."""
    return Reservation.objects.filter(
        stock_item__pk=item_pk,
        cancelled_at__isnull=True,
        loan__isnull=True,
        end_date__gte=timezone.localdate(),
    ).select_related("reserved_for_user", "created_by")


class PluginAwareView(APIView):
    """Vue de base : recoit une reference au plugin pour lire ses reglages."""

    permission_classes = [IsAuthenticated]

    # Injecte par setup_urls via as_view(plugin=...)
    plugin = None

    def reservations_enabled(self):
        """Le systeme de reservation est-il active dans les reglages ?"""
        if not self.plugin:
            return False
        try:
            return bool(self.plugin.get_setting("ENABLE_RESERVATIONS"))
        except Exception:
            return False


class LendView(PluginAwareView):
    """POST lend : preter un objet trackable."""

    def post(self, request):
        """Cree un pret apres validation de l'objet et de l'emprunteur."""
        data = request.data

        item_pk = data.get("stock_item")
        if not item_pk:
            return Response(
                {"error": _("The 'stock_item' field is required.")},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            item = StockItem.objects.get(pk=item_pk)
        except (StockItem.DoesNotExist, ValueError):
            return Response(
                {"error": _("Stock item not found.")},
                status=status.HTTP_404_NOT_FOUND,
            )

        # Le pret est reserve aux objets trackables
        if not item.part.trackable:
            return Response(
                {"error": _("This item is not trackable, it cannot be lent.")},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Emprunteur : membre (pk) ou nom libre
        borrower_user = None
        user_pk = data.get("borrower_user")
        if user_pk:
            try:
                borrower_user = get_user_model().objects.get(pk=user_pk)
            except (get_user_model().DoesNotExist, ValueError):
                return Response(
                    {"error": _("Borrower user not found.")},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        # borne du CharField (200) : au-dela, Postgres leverait une DataError
        borrower_name = str(data.get("borrower_name") or "").strip()[:200]

        if not borrower_user and not borrower_name:
            return Response(
                {"error": _("A borrower is required (borrower_user or borrower_name).")},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Self-service : on emprunte a SON nom. Preter AU NOM D'UN AUTRE MEMBRE
        # est reserve aux admins — c'est ainsi qu'un admin confirme la
        # reservation d'un membre (le pret est enregistre au nom du membre, sa
        # reservation est honoree ci-dessous). Le repli borrower_name (compte
        # sans pk) reste du self-service, non concerne.
        lends_for_other = bool(
            borrower_user and borrower_user.pk != request.user.pk
        )
        if lends_for_other and not is_prets_admin(request.user):
            return Response(
                {
                    "error": _(
                        "Only an administrator can lend on behalf of "
                        "someone else."
                    )
                },
                status=status.HTTP_403_FORBIDDEN,
            )

        existing = Loan.objects.filter(
            stock_item=item, returned_at__isnull=True
        ).first()
        if existing is not None:
            # double clic sur Emprunter : renvoyer son propre emprunt en cours
            if borrower_user and existing.borrower_user_id == borrower_user.pk:
                return Response(
                    LoanSerializer(existing, context={"request": request}).data,
                    status=status.HTTP_200_OK,
                )
            return Response(
                {"error": _("This item is already on loan.")},
                status=status.HTTP_409_CONFLICT,
            )

        # Echeance : fournie, sinon aujourd'hui + duree par defaut
        due_on = data.get("due_on")
        if due_on:
            try:
                due_on = datetime.date.fromisoformat(str(due_on))
            except ValueError:
                return Response(
                    {"error": _("Invalid 'due_on' format (expected YYYY-MM-DD).")},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if due_on < timezone.localdate():
                return Response(
                    {"error": _("The due date cannot be before today.")},
                    status=status.HTTP_400_BAD_REQUEST,
                )
        else:
            duration = 1
            if self.plugin:
                duration = int(self.plugin.get_setting("LOAN_DURATION_DAYS"))
            due_on = timezone.localdate() + datetime.timedelta(days=duration)

        # Pendant un creneau reserve, seul le beneficiaire prend l'objet (il
        # confirme ainsi sa reservation, ou un admin la confirme A SON NOM) ;
        # et un emprunt dont la periode [aujourd'hui, retour] mord sur un
        # creneau d'autrui est refuse. Les admins passent outre. Les creneaux
        # de l'emprunteur couverts par ce pret sont confirmes (relies ci-dessous).
        own_resas = []
        if self.reservations_enabled():
            today = timezone.localdate()
            overlapping = active_reservations(item.pk).filter(start_date__lte=due_on)
            for r in overlapping:
                if borrower_user and r.reserved_for_user_id == borrower_user.pk:
                    own_resas.append(r)
                elif not is_prets_admin(request.user):
                    # dates au format d'affichage du demandeur (reglage InvenTree)
                    _full, short = user_date_fmts(request.user)
                    if r.start_date <= today:
                        # creneau en cours : l'objet est reserve, point
                        return Response(
                            {
                                "error": _(
                                    "Reserved by {who} until {end}."
                                ).format(
                                    who=r.reserved_for_label(),
                                    end=r.end_date.strftime(short),
                                )
                            },
                            status=status.HTTP_409_CONFLICT,
                        )
                    return Response(
                        {
                            "error": _(
                                "Reserved by {who} {slot}: "
                                "the return must be before {date}."
                            ).format(
                                who=r.reserved_for_label(),
                                slot=slot_label(
                                    r.start_date, r.end_date, short
                                ),
                                date=r.start_date.strftime(short),
                            )
                        },
                        status=status.HTTP_409_CONFLICT,
                    )

        loan = Loan.objects.create(
            stock_item=item,
            borrower_user=borrower_user,
            borrower_name=borrower_name,
            due_on=due_on,
            lent_by=request.user,
            notes=str(data.get("notes") or "")[:2000],
            on_behalf=str(data.get("on_behalf") or "").strip()[:200],
        )

        # Badge 'Emprunté' dans le tableau de stock (si active dans les reglages)
        if self.plugin:
            self.plugin.apply_loan_status(loan)
            # Recu d'emprunt a l'emprunteur membre (email seul), qui nomme
            # l'auteur quand un admin a enregistre le pret a son nom.
            self.plugin.notify_loan_created(loan)

        # Les creneaux de l'emprunteur couverts par ce pret sont honores
        for r in own_resas:
            r.loan = loan
            r.save(update_fields=["loan"])

        return Response(
            LoanSerializer(loan, context={"request": request}).data,
            status=status.HTTP_201_CREATED,
        )


class ReturnView(PluginAwareView):
    """POST return : enregistrer le retour d'un objet."""

    def post(self, request):
        """Cloture le pret actif designe par 'loan' (pk) ou 'stock_item'."""
        data = request.data
        loan = None

        loan_pk = data.get("loan")
        item_pk = data.get("stock_item")

        if loan_pk:
            loan = Loan.objects.filter(pk=loan_pk, returned_at__isnull=True).first()
        elif item_pk:
            loan = Loan.objects.filter(
                stock_item__pk=item_pk, returned_at__isnull=True
            ).first()

        if loan is None:
            return Response(
                {"error": _("No active loan found for this item.")},
                status=status.HTTP_404_NOT_FOUND,
            )

        # Retour reserve a l'emprunteur, a qui a enregistre le pret, et aux
        # admins (l'emprunteur reste autorise meme si un admin a confirme le
        # pret a son nom).
        if not (
            is_prets_admin(request.user)
            or loan.lent_by_id == request.user.pk
            or loan.borrower_user_id == request.user.pk
        ):
            return Response(
                {
                    "error": _(
                        "Only the borrower, the person who registered the "
                        "loan, or an admin can record the return."
                    )
                },
                status=status.HTTP_403_FORBIDDEN,
            )

        # Trace du retour : qui l'a enregistre (emprunteur, preteur ou admin).
        loan.returned_at = timezone.now()
        loan.returned_by = request.user
        loan.save(update_fields=["returned_at", "returned_by"])

        # Restaure le statut d'affichage de l'objet
        if self.plugin:
            self.plugin.clear_loan_status(loan)
            # Recu de cloture a l'emprunteur membre (email seul), qui nomme
            # l'auteur du retour quand ce n'est pas lui.
            self.plugin.notify_loan_returned(loan)

        return Response(
            LoanSerializer(loan, context={"request": request}).data,
            status=status.HTTP_200_OK,
        )


class ActiveLoansView(ListAPIView):
    """GET active : liste des prets en cours."""

    permission_classes = [IsAuthenticated]
    serializer_class = LoanSerializer
    plugin = None

    def get_queryset(self):
        """Prets non rendus."""
        return Loan.objects.filter(returned_at__isnull=True).select_related(
            "stock_item__part", "borrower_user", "lent_by"
        )


class OverdueLoansView(ListAPIView):
    """GET overdue : liste des prets en retard."""

    permission_classes = [IsAuthenticated]
    serializer_class = LoanSerializer
    plugin = None

    def get_queryset(self):
        """Prets non rendus dont l'echeance est depassee."""
        return Loan.objects.filter(
            returned_at__isnull=True,
            due_on__lt=timezone.localdate(),
        ).select_related("stock_item__part", "borrower_user", "lent_by")


class LoanHistoryView(ListAPIView):
    """GET loans : historique pagine des prets.

    Filtre optionnel ?stock_item=<pk>. La pagination limit/offset de DRF
    (celle des tableaux natifs InvenTree) s'active des que 'limit' est passe
    et renvoie {count, next, previous, results}.
    """

    permission_classes = [IsAuthenticated]
    serializer_class = LoanSerializer
    plugin = None

    def get_queryset(self):
        """Tous les prets, du plus recent au plus ancien.

        Filtres alignes sur ceux du tableau de suivi de stock natif :
        search, min_date, max_date (sur la date de pret) et user (lent_by).
        """
        params = self.request.query_params
        qs = Loan.objects.all().select_related(
            "stock_item__part", "borrower_user", "lent_by"
        )

        item_pk = params.get("stock_item")
        if item_pk:
            qs = qs.filter(stock_item__pk=item_pk)

        search = str(params.get("search") or "").strip()
        if search:
            qs = qs.filter(
                Q(borrower_name__icontains=search)
                | Q(borrower_user__username__icontains=search)
                | Q(borrower_user__first_name__icontains=search)
                | Q(borrower_user__last_name__icontains=search)
                | Q(notes__icontains=search)
                | Q(stock_item__serial__icontains=search)
            )

        for param, lookup in (
            ("min_date", "lent_at__date__gte"),
            ("max_date", "lent_at__date__lte"),
        ):
            value = params.get(param)
            if value:
                try:
                    qs = qs.filter(
                        **{lookup: datetime.date.fromisoformat(str(value))}
                    )
                except ValueError:
                    pass

        user_pk = params.get("user")
        if user_pk:
            qs = qs.filter(lent_by__pk=user_pk)

        return qs


class ConfigView(PluginAwareView):
    """GET config : reglages publics du plugin, pour les clients (Scannette).

    La Scannette lit ce endpoint pour savoir si le systeme de reservation
    est active, sans avoir besoin d'acceder aux reglages internes du plugin.
    """

    def get(self, request):
        """Renvoie les reglages utiles aux clients."""
        reservations = False
        duration = 1
        on_behalf = False

        if self.plugin:
            try:
                reservations = bool(self.plugin.get_setting("ENABLE_RESERVATIONS"))
                duration = int(self.plugin.get_setting("LOAN_DURATION_DAYS"))
                on_behalf = bool(self.plugin.get_setting("ASK_ON_BEHALF"))
            except Exception:
                pass

        # URL de l'interface InvenTree (« ordinateur ») : la Scannette y renvoie
        # pour l'historique complet, depuis un sous-domaine distinct du sien.
        # On NE passe PAS la requete (le proxy interne la verrait en http) : sans
        # requete, construct_absolute_url s'appuie sur INVENTREE_SITE_URL (https),
        # exactement comme le lien des emails.
        site_url = ""
        try:
            from InvenTree.helpers_model import construct_absolute_url

            site_url = construct_absolute_url("") or ""
        except Exception:
            pass

        return Response(
            {
                "reservations_enabled": reservations,
                "loan_duration_days": duration,
                "ask_on_behalf": on_behalf,
                "site_url": site_url,
            }
        )


class ItemLoanView(PluginAwareView):
    """GET item/<pk> : pret actif d'un objet precis."""

    def get(self, request, pk):
        """Renvoie {active, loan?, history, reservations} pour un objet.

        history : les prets recents de l'objet (le plus recent d'abord).
        reservations : creneaux a venir ou en cours (liste vide si le
        systeme de reservation est desactive), du plus proche au plus loin.
        """
        active_loan = Loan.objects.filter(
            stock_item__pk=pk, returned_at__isnull=True
        ).first()

        history = Loan.objects.filter(stock_item__pk=pk)[:20]
        ctx = {"request": request}

        payload = {
            "active": active_loan is not None,
            "history": LoanSerializer(history, many=True, context=ctx).data,
            "reservations": [],
        }
        if active_loan is not None:
            payload["loan"] = LoanSerializer(active_loan, context=ctx).data

        if self.reservations_enabled():
            payload["reservations"] = ReservationSerializer(
                active_reservations(pk), many=True, context=ctx
            ).data

        return Response(payload)


class ReserveView(PluginAwareView):
    """POST reserve : reserver un objet trackable sur un creneau."""

    def post(self, request):
        """Cree une reservation apres validation du creneau."""
        if not self.reservations_enabled():
            return Response(
                {"error": _("The reservation system is disabled.")},
                status=status.HTTP_400_BAD_REQUEST,
            )

        data = request.data

        item_pk = data.get("stock_item")
        if not item_pk:
            return Response(
                {"error": _("The 'stock_item' field is required.")},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            item = StockItem.objects.get(pk=item_pk)
        except (StockItem.DoesNotExist, ValueError):
            return Response(
                {"error": _("Stock item not found.")},
                status=status.HTTP_404_NOT_FOUND,
            )

        if not item.part.trackable:
            return Response(
                {"error": _("This item is not trackable, it cannot be reserved.")},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Beneficiaire : membre (pk) ou nom libre
        reserved_for_user = None
        user_pk = data.get("reserved_for_user")
        if user_pk:
            try:
                reserved_for_user = get_user_model().objects.get(pk=user_pk)
            except (get_user_model().DoesNotExist, ValueError):
                return Response(
                    {"error": _("Beneficiary user not found.")},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        # borne du CharField (200) : au-dela, Postgres leverait une DataError
        reserved_for_name = str(data.get("reserved_for_name") or "").strip()[:200]

        if not reserved_for_user and not reserved_for_name:
            return Response(
                {
                    "error": _(
                        "A beneficiary is required "
                        "(reserved_for_user or reserved_for_name)."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Creneau [start_date, end_date]
        try:
            start = datetime.date.fromisoformat(str(data.get("start_date")))
            end = datetime.date.fromisoformat(str(data.get("end_date")))
        except (TypeError, ValueError):
            return Response(
                {
                    "error": _(
                        "Invalid 'start_date'/'end_date' format (expected YYYY-MM-DD)."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        today = timezone.localdate()
        if start < today:
            return Response(
                {"error": _("The start date cannot be before today.")},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if end < start:
            return Response(
                {"error": _("The end date cannot be before the start date.")},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Un creneau qui mord sur l'emprunt en cours n'a pas de sens :
        # l'objet ne sera pas la. Le creneau doit commencer apres le retour
        # prevu (apres aujourd'hui si le pret est deja en retard, pari que
        # l'objet revient). Regle uniforme, admins compris.
        active_loan = Loan.objects.filter(
            stock_item=item, returned_at__isnull=True
        ).first()
        if active_loan:
            limit = active_loan.due_on or today
            if limit < today:
                limit = today
            if start <= limit:
                _full, short = user_date_fmts(request.user)
                return Response(
                    {
                        "error": _(
                            "Borrowed by {who}, expected back on {date}: "
                            "the slot must start later."
                        ).format(
                            who=active_loan.borrower_label(),
                            date=limit.strftime(short),
                        )
                    },
                    status=status.HTTP_409_CONFLICT,
                )

        # Un seul beneficiaire par creneau : refus si chevauchement avec une
        # autre reservation active de l'objet.
        clash = (
            active_reservations(item.pk)
            .filter(start_date__lte=end, end_date__gte=start)
            .first()
        )
        if clash:
            _full, short = user_date_fmts(request.user)
            return Response(
                {
                    "error": _(
                        "This slot overlaps the reservation of {who} ({slot})."
                    ).format(
                        who=clash.reserved_for_label(),
                        slot=slot_label(clash.start_date, clash.end_date, short),
                    )
                },
                status=status.HTTP_409_CONFLICT,
            )

        reservation = Reservation.objects.create(
            stock_item=item,
            reserved_for_user=reserved_for_user,
            reserved_for_name=reserved_for_name,
            start_date=start,
            end_date=end,
            notes=str(data.get("notes") or "")[:2000],
            on_behalf=str(data.get("on_behalf") or "").strip()[:200],
            created_by=request.user,
        )

        # Creneau qui commence aujourd'hui : on previent tout de suite (email +
        # cloche) le beneficiaire, au lieu d'attendre la tache quotidienne.
        # Creneau a venir : recu de reservation (email seul), jamais les deux.
        if self.plugin and reserved_for_user:
            if start <= today:
                self.plugin.notify_reservation_started_now(reservation)
            else:
                self.plugin.notify_reservation_created(reservation)

        return Response(
            ReservationSerializer(reservation, context={"request": request}).data,
            status=status.HTTP_201_CREATED,
        )


class ReservationCancelView(PluginAwareView):
    """POST reservation/cancel : annuler une reservation active.

    Corps : 'reservation' (pk), et 'reason' facultatif — le motif de
    l'annulation, transmis au beneficiaire dans l'email de prevenance et
    conserve en base (Reservation.cancel_reason, non expose par l'API).
    """

    def post(self, request):
        """Annule la reservation designee par 'reservation' (pk)."""
        res_pk = request.data.get("reservation")
        reservation = (
            Reservation.objects.filter(
                pk=res_pk, cancelled_at__isnull=True, loan__isnull=True
            ).first()
            if res_pk
            else None
        )

        if reservation is None:
            return Response(
                {"error": _("No active reservation found.")},
                status=status.HTTP_404_NOT_FOUND,
            )

        # Annulation reservee a qui a cree la reservation, et aux admins
        if not (
            is_prets_admin(request.user)
            or reservation.created_by_id == request.user.pk
        ):
            return Response(
                {
                    "error": _(
                        "Only the person who created the reservation "
                        "(or an admin) can cancel it."
                    )
                },
                status=status.HTTP_403_FORBIDDEN,
            )

        # Annuler la reservation de QUELQU'UN D'AUTRE le previent par email :
        # un motif est alors OBLIGATOIRE (meme exigence que l'emprunt admin).
        reason = str(request.data.get("reason") or "").strip()[:500]
        cancels_for_other = bool(
            reservation.reserved_for_user
            and reservation.reserved_for_user.pk != request.user.pk
        )
        if cancels_for_other and not reason:
            return Response(
                {
                    "error": _(
                        "A reason is required to cancel someone else's "
                        "reservation."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Trace d'annulation : qui et pourquoi. Conservee en base (admin Django)
        # mais jamais renvoyee par le serializer — cf. Reservation.cancelled_by.
        reservation.cancelled_at = timezone.now()
        reservation.cancelled_by = request.user
        reservation.cancel_reason = reason
        reservation.save(
            update_fields=["cancelled_at", "cancelled_by", "cancel_reason"]
        )

        # Le beneficiaire membre recoit toujours un email, dans sa langue :
        # - annulee par quelqu'un d'autre (createur ou admin) : prevenance
        #   (cloche + email) avec le motif (desormais obligatoire) ;
        # - annulee par lui-meme : simple confirmation (email seul, pas de
        #   cloche pour sa propre action), creneau en cours ou a venir.
        if self.plugin and reservation.reserved_for_user:
            if cancels_for_other:
                self.plugin.notify_reservation_cancelled(
                    reservation, request.user, reason
                )
            else:
                self.plugin.notify_reservation_self_cancelled(reservation)

        return Response(
            ReservationSerializer(reservation, context={"request": request}).data,
            status=status.HTTP_200_OK,
        )


class ReservationListView(ListAPIView):
    """GET reservations : reservations d'un objet (ou de tous).

    Par defaut, seules les reservations actives (a venir ou en cours).
    ?all=1 renvoie tout, y compris annulees, honorees et passees (pour
    l'onglet Historique de la Scannette). Pagination limit/offset de DRF
    des que 'limit' est passe.
    """

    permission_classes = [IsAuthenticated]
    serializer_class = ReservationSerializer
    plugin = None

    def get_queryset(self):
        """Reservations filtrees par objet et par etat."""
        params = self.request.query_params

        qs = Reservation.objects.all().select_related(
            "stock_item__part", "reserved_for_user", "created_by"
        )

        item_pk = params.get("stock_item")
        if item_pk:
            qs = qs.filter(stock_item__pk=item_pk)

        if str(params.get("all") or "") not in ("1", "true"):
            qs = qs.filter(
                cancelled_at__isnull=True,
                loan__isnull=True,
                end_date__gte=timezone.localdate(),
            )

        return qs


class GoItemView(APIView):
    """GET go/<pk> : redirection vers la fiche d'un objet, mobile ou ordinateur.

    Cible des boutons d'emails : au moment de l'envoi, impossible de savoir
    sur quel appareil le lien sera ouvert. L'email pointe donc ici, et la
    redirection choisit AU CLIC, d'apres le User-Agent (meme regle que
    l'interstitiel mobile du proxy) :
    - mobile -> la Scannette, fiche de l'objet ;
    - sinon  -> la fiche InvenTree de l'objet (/platform/stock/item/<pk>).

    L'adresse de la Scannette n'est PAS demandee en reglage : elle se deduit
    de l'hote InvenTree lui-meme (le clic vient de son propre lien d'email,
    donc request.get_host() = l'hote InvenTree), d'apres la convention de
    deploiement « inventaire[-<nom>] » <-> « scannette[-<nom>] ». Si l'hote ne
    suit pas cette convention (dev sslip.io, sous-domaine personnalise...), on
    retombe simplement sur la fiche InvenTree — jamais de lien casse.

    Endpoint PUBLIC (le clic vient d'un email, souvent sans session ouverte) :
    il ne lit rien en base et ne revele donc rien — chaque cible redemande
    de toute facon une connexion.
    """

    permission_classes = [AllowAny]
    plugin = None

    MOBILE_UA = re.compile(r"android|iphone|ipod|mobile", re.IGNORECASE)

    @staticmethod
    def _scannette_url(request):
        """Deduit l'adresse de la Scannette depuis l'hote InvenTree.

        Convention create-asso.sh : le premier label du domaine InvenTree est
        « inventaire » (asso principale) ou « inventaire-<nom> », et celui de
        la Scannette « scannette »/« scannette-<nom> » sur le meme domaine. On
        remplace donc le prefixe « inventaire » du premier label par
        « scannette ». Hors convention -> "" (repli sur la fiche InvenTree).
        """
        host = request.get_host()  # ex. inventaire-bde.eirspace.fr[:port]
        hostname = host.split(":", 1)[0]
        labels = hostname.split(".")
        first = labels[0]
        if first == "inventaire":
            labels[0] = "scannette"
        elif first.startswith("inventaire-"):
            labels[0] = "scannette-" + first[len("inventaire-"):]
        else:
            return ""
        return f"{request.scheme}://{'.'.join(labels)}"

    def get(self, request, pk):
        """Redirige vers la Scannette (mobile) ou la fiche InvenTree."""
        ua = request.META.get("HTTP_USER_AGENT", "")
        if self.MOBILE_UA.search(ua):
            scannette = self._scannette_url(request)
            if scannette:
                return HttpResponseRedirect(f"{scannette}/?item={pk}")

        # ordinateur (ou hote hors convention Scannette) : fiche InvenTree, sur
        # l'onglet « Prêts » DIRECTEMENT (panneau du plugin, cle "prets-panel")
        # pour que le beneficiaire confirme sans chercher l'onglet. URL en
        # relatif (meme origine que le lien de l'email). pui_url pose le bon
        # prefixe d'interface (/web par defaut) depuis les reglages, sans
        # jamais le coder en dur — aucun acces base. Repli gracieux du front
        # si le panneau tarde a charger : la fiche du bon objet s'affiche, et
        # l'onglet Prets se selectionne des qu'il est pret.
        panel = f"/stock/item/{pk}/prets-panel"
        try:
            from InvenTree.helpers import pui_url

            target = pui_url(panel)
        except Exception:
            target = f"/web{panel}"
        return HttpResponseRedirect(target)
