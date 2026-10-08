# Contrat SwipSales → Brevo (pour la configuration des parcours)

État au 8 octobre 2026, branche `claude/brevo-automation`. **Rien n'est actif** : ce contrat décrit ce que l'application enverra une fois la migration appliquée et les flags activés après recette. Il ne garantit pas qu'un email part : seul un test sur un contact de recette le prouve.

## 1. Règles générales

- **Identification du contact** : chaque événement est envoyé à Brevo (`POST /v3/events`) avec `identifiers.email_id` = email du compte SwipSales du **destinataire** indiqué ci-dessous. Jamais une adresse fournie par le navigateur.
- **Avant chaque événement**, le contact est créé/mis à jour avec les attributs de la section 4.
- **Propriétés d'événement = valeurs simples uniquement** (texte, nombre, booléen ; contrainte Brevo). Les listes sont aplaties : `offre_1_poste`, `offre_1_entreprise`, `offre_1_score`, `offre_1_id`, …, `offre_5_*` ; `candidat_1_id`, `candidat_1_score`, …, `candidat_20_*`. Une valeur absente n'est pas transmise : prévoir un texte par défaut dans le modèle.
- **Propriétés communes à tous les événements** : `event_id` (identifiant unique, à utiliser pour repérer un doublon), `occurred_at` (ISO), `lien` (application, connexion requise), `lien_preferences` (ouvre les préférences d'emails). `prenom` est ajouté quand il est connu.
- **Propriétés techniques** : d'autres propriétés peuvent apparaître (`candidat_id`, `created_at`, `match_id`…). Elles servent au suivi ; ne pas les afficher dans un email.
- **Livraison « au moins une fois »** : un même `event_id` peut exceptionnellement arriver deux fois (timeout réseau après acceptation par Brevo). Ne jamais promettre « exactement une fois ».
- **Délais** : les relances (section 3) sont émises **après** le délai prévu. **Ne pas ajouter de second délai 24 h / 48 h dans Brevo.**
- **Relances = marketing** : elles ne partent que si l'utilisateur a coché « Recevoir les recommandations et relances SwipSales par email » (attribut `AUTOMATION_MARKETING_ALLOWED=true`). **Valeur par défaut : non coché.** Dans chaque parcours de relance, vérifier aussi `AUTOMATION_MARKETING_ALLOWED` juste avant l'email.
- **Un seul responsable par email** : soit le parcours Brevo, soit le mapping transactionnel applicatif (section 6), jamais les deux.
- **Aucune donnée sensible transmise** : pas de contenu de message, pas de réponse ADN, pas de pièce jointe, pas d'identité d'un candidat qui n'a pas postulé volontairement à l'offre du recruteur.

## 2. Événements immédiats (faits métier)

Ces événements sont **des notifications de service** (pas de condition de consentement marketing). Capturés dans la même transaction que l'action (trigger SQL) ou depuis le webhook Stripe signé.

| Événement | Destinataire | Déclencheur | Propriétés spécifiques |
|---|---|---|---|
| `signup_completed` | le nouvel utilisateur | création de la fiche candidat ou recruteur | `role` = `CANDIDAT` \| `RECRUTEUR` |
| `profile_updated` | candidat | changement réel de prénom, nom, titre, axes, score ADN ou compétences | `completion` (0–100) |
| `adn_started` | candidat | ouverture de la 1re étape du test ADN, consentement ADN vérifié (max 1/jour) | — |
| `adn_completed` | candidat | résultat ADN enregistré ou modifié | `score` |
| `application_submitted` | candidat | candidature envoyée par swipe (like ou super-like) | `application_id`, `offre_id`, `poste`, `entreprise`, `statut`, `score`* |
| `application_received` | recruteur propriétaire de l'offre | idem | idem + `candidat` (prénom nom **figés dans la candidature**) |
| `offer_first_application` | recruteur | toute première candidature de l'offre (y compris celles d'avant l'installation) | idem `application_received` |
| `application_status_changed` | candidat | changement de statut dans le pipeline recruteur | idem `application_submitted` + `previous_status`, `statut` |
| `message_received` | destinataire du message | chaque message | `message_id`, `conversation_id`, `offre_id`, `poste`, `entreprise`, `score`*, `candidat`** |
| `message_sent` | expéditeur | chaque message | idem `message_received` |
| `first_message_sent` | les deux participants | premier message d'une conversation | idem |
| `message_read` | expéditeur du message lu | message marqué lu | idem (un événement par message lu) |
| `match_created` | candidat **et** recruteur (2 événements) | création d'une conversation | `conversation_id`, `match_id`, `offre_id`, `candidat_id`, `poste`, `entreprise`, `score`*, `candidat`** |
| `offer_published` | recruteur | publication ou réactivation d'une offre | `offre_id`, `poste`, `entreprise`, `expires_at` (si défini) |
| `offer_limit_reached` | recruteur | quota d'offres actives atteint (max 1/jour/formule) | `plan`, `limit` |
| `like_received` | candidat | like d'un recruteur (ancien `like_recu`) | `nb` (likes 7 jours) |
| `profile_viewed` | candidat | consultation par un recruteur (ancien `profil_consulte`) | `nb` (consultations 7 jours) |
| `swipe_performed` | candidat | tout swipe (ancien `swipe_effectue`) | `action` = `like` \| `super` \| `pass` |

\* `score` = compatibilité réelle (axes ADN × pondérations du recruteur). **Absente** si elle n'est pas mesurable : aucune valeur fictive.
\*\* `candidat` n'existe que pour le recruteur : prénom/nom de la candidature volontaire à cette offre, sinon `Candidat anonyme`.

Valeurs de `statut` / `previous_status` : `envoyee`, `nouveau`, `vu`, `contacte`, `repondu`, `entretien`, `offre`, `embauche`, `refusee`, `retiree`. `contacte` = contact enregistré par le recruteur. `entretien` ne porte **ni date ni créneau**. Une embauche se repère avec `statut = embauche` (pas d'événement `hire_confirmed`). Un changement rapide de colonne dans le pipeline produit un événement par changement : ne brancher des emails que sur les statuts utiles.

## 3. Les dix scénarios (relances calculées par SwipSales)

Toutes ces relances exigent `AUTOMATION_MARKETING_ALLOWED = true`. Elles sont **revérifiées juste avant l'envoi** à Brevo ; si la condition n'est plus vraie, l'événement n'est pas envoyé.

| # | Scénario | Événement | Destinataire | Quand SwipSales l'émet | Propriétés | Annulé avant envoi si… |
|---|---|---|---|---|---|---|
| 1 | Profil incomplet | `profile_incomplete` | candidat | 1×/semaine tant que < 100 %, pas avant 24 h après l'inscription | `completion` | profil à 100 % |
| 2 | Nouvelle offre compatible | `compatible_offer_found` | candidat | offre publiée depuis < 48 h (et après l'installation), score ≥ 70 | `offre_id`, `poste`, `entreprise`, `score` | offre fermée/expirée, score < 70, déjà postulé, offre passée |
| 3 | Offre consultée sans candidature | `offer_viewed_without_application` | candidat | 24 h après la 1re consultation (carte visible 2 s), une seule fois par offre | `offre_id`, `poste`, `entreprise` | candidature, swipe, offre passée/écartée, offre fermée |
| 4 | Tentative de candidature interrompue | `application_abandoned` | candidat | 24 h après un swipe de candidature **dont l'envoi n'a pas abouti** | `offre_id`, `poste`, `entreprise` | candidature enregistrée, offre fermée |
| 5 | Suivi de candidature | `application_submitted`, `application_received`, `application_status_changed` | voir section 2 | immédiat | voir section 2 | — (service) |
| 6 | Message sans réponse | `recruiter_message_unanswered` | candidat | 48 h après le dernier message, s'il vient du recruteur | `conversation_id`, `message_id`, `offre_id`, `poste`, `entreprise` | réponse du candidat ou nouveau message, candidature `refusee` / `retiree` / `embauche` |
| 7 | Recommandations | `weekly_recommendations` | candidat | 1×/semaine, à partir d'une semaine après l'installation | `nb`, `offre_1_*` … `offre_5_*` (`id`, `poste`, `entreprise`, `score`) | plus aucune offre valide |
| 8 | Inactivité | `user_inactive` | candidat | 7, 14 puis 30 jours sans activité (seul le palier atteint le plus élevé si le service reprend tard) | `days`, `nb`, `offre_1_*` … `offre_5_*` (offres créées depuis la dernière visite) | retour de l'utilisateur |
| 9 | Nouveaux profils compatibles | `compatible_candidates_found` | recruteur propriétaire de l'offre | nouveaux profils compatibles (≥ 70) inscrits ou mis à jour après l'installation, regroupés par offre | `offre_id`, `poste`, `nb`, `candidat_1_id`, `candidat_1_score` … `candidat_20_*` (**identifiants et scores uniquement**) | offre fermée, plus de profil compatible non candidat |
| 10a | Offre bientôt expirée | `offer_expiring` | recruteur | dans les 3 derniers jours avant `date_fin` | `offre_id`, `poste`, `date_fin`, `role` | offre fermée, date modifiée |
| 10b | Offre enregistrée bientôt expirée | `saved_offer_expiring` | candidat | idem, si l'offre est enregistrée | `offre_id`, `poste`, `entreprise`, `date_fin` | offre désenregistrée, candidature, date modifiée |

Notes produit :
- Scénario 4 : la candidature se fait par swipe, sans formulaire multiétape. « Interrompue » = l'envoi a été tenté mais aucune candidature n'a été enregistrée (erreur réseau, échec de copie du CV…).
- Scénario 8 : seuls les candidats sont concernés. L'activité est enregistrée avec une précision d'une heure, sessions OAuth comprises ; un onglet laissé en arrière-plan ne compte pas.
- Scénario 10 : la date de fin est **facultative** et choisie par le recruteur ; les offres existantes n'en ont pas. Les offres expirées sont fermées automatiquement et refusent les candidatures.
- `nb` peut valoir 0 dans `user_inactive` : prévoir une variante de texte.

## 4. Attributs de contact mis à jour par SwipSales

À créer dans Brevo **avec ces types** avant la recette (un attribut inconnu ou mal typé peut faire rejeter la mise à jour du contact ; l'événement est alors réessayé puis abandonné après 12 tentatives, soit environ 17 h).

| Attribut | Type | Valeurs |
|---|---|---|
| `ROLE` | texte | `CANDIDAT`, `RECRUTEUR` |
| `PRENOM`, `NOM` | texte | |
| `AUTOMATION_MARKETING_ALLOWED` | booléen | choix explicite de l'utilisateur, `false` par défaut |
| `DERNIERE_ACTIVITE` | texte (ISO 8601) | précision 1 h |
| `PROFIL_COMPLETION` | nombre | 0–100 (candidats) |
| `SCORE_ADN` | nombre | 0 si pas de test |
| `TEST_ADN_TERMINE` | booléen | |
| `OFFRE_PUBLIEE` | booléen | `true` après `offer_published` |
| `PLAN` | texte | `GRATUIT`, `CARRIERE`, `COACHING`, `ENTREPRENEUR`, `STARTER`, `PRO`, `ENTERPRISE` |
| `FACTURATION` | texte | `MENSUEL`, `ANNUEL` |
| `STATUT_ABO` | texte | `AUCUN` (gratuit), `ACTIF`, `RESILIATION_PROGRAMMEE`, `IMPAYE` (= abonnement payant non actif : impayé, incomplet…) |
| `ABONNEMENT_PLAN`, `ABONNEMENT_STATUT`, `ABONNEMENT_DATE_FIN` | texte | anciennes valeurs brutes (`carriere`, `actif`…), conservées pendant la transition |
| `NB_LIKES_7J`, `NB_CONSULTATIONS_7J` | nombre | inchangés |

`ADN_STATUT`, `NOTIF_EMAIL` et `OPT_IN_MARKETING` (noms du pack) **ne sont pas alimentés** : utiliser `TEST_ADN_TERMINE` et `AUTOMATION_MARKETING_ALLOWED`.

## 5. Facturation (webhook Stripe)

| Événement | Destinataire | Déclencheur Stripe | Propriétés |
|---|---|---|---|
| `checkout_started` | utilisateur | ouverture d'un paiement Stripe depuis l'application | `plan`, `facturation` |
| `subscription_started` | abonné | `checkout.session.completed` / `async_payment_succeeded` **payé** | `plan`, `facturation`, `montant`, `stripe_event_id` |
| `payment_succeeded` | abonné | `invoice.payment_succeeded` | `plan`, `facturation`, `montant`, `amount_minor`, `currency`, `numero_paiement` (n° de facture Stripe), `invoice_id`, `payment_url`, `billing_reason`, `stripe_event_id` |
| `payment_failed` | abonné | `invoice.payment_failed` | idem ; `lien` = page de paiement de la facture Stripe |
| `subscription_cancel_scheduled` | abonné | résiliation programmée en fin de période | `plan`, `facturation`, `date_fin` |
| `subscription_reactivated` | abonné | résiliation annulée | idem |
| `plan_changed` | abonné | changement de formule payante à payante | idem + `ancien_plan`, `nouveau_plan` |
| `subscription_updated` | abonné | toute autre mise à jour d'abonnement | idem |
| `subscription_ended` | abonné | `customer.subscription.deleted` | `plan`, `facturation` |

- `billing_reason` : `subscription_create` (1er paiement, déjà couvert par `subscription_started` : filtrer pour éviter deux emails), `subscription_cycle` (renouvellement), `subscription_update` (prorata).
- `montant` est une chaîne `"19.00"` en euros ; vide si la devise n'est pas l'euro.
- `numero_paiement` est le **numéro de facture Stripe**, pas un compteur « 2e paiement ».
- `plan_changed` n'est détecté que si les métadonnées Stripe de l'abonnement changent ; l'application ne propose pas aujourd'hui de changement de formule sans nouvel abonnement.
- Aucune date de suspension n'est transmise : la politique après un impayé n'est pas définie.
- **Non couvert** : fin d'essai, carte expirante, rappel avant renouvellement (`invoice.upcoming`), remboursement. Les « 14 notifications de facturation » du cahier des charges n'ont pas été identifiées une à une : **elles ne sont pas déclarées opérationnelles**. Il faut les lister avec ce tableau en regard.

## 6. Emails transactionnels envoyés par l'application (optionnel)

Par défaut (`BREVO_TRANSACTIONAL_TEMPLATES={}`), **SwipSales n'envoie que des événements** : les emails partent des parcours Brevo.

Pour qu'un email parte directement de l'application, fournir à l'équipe technique l'association **événement → ID numérique du modèle Brevo**, par exemple `{"payment_failed": 55, "application_status_changed:entretien": 61}`. Événements autorisés : `application_submitted`, `application_received`, `application_status_changed` (éventuellement `:statut`), `message_received`, `payment_succeeded`, `payment_failed`, `subscription_started`, `subscription_cancel_scheduled`, `subscription_ended`, `subscription_reactivated`, `plan_changed`. Les relances marketing sont refusées dans ce mode.

- Variables du modèle : `{{ params.<propriété> }}` avec les noms des sections 2 et 5 (les listes restent des listes dans ce mode).
- Le modèle doit être **actif** et utiliser le nouveau langage de modèles Brevo. Exemple vu dans le compte : `SWIP-C13-1` (#55, paiement échoué) attend `prenom`, `plan`, `montant`, `lien`, `lien_preferences`. Ces noms correspondent, **mais le modèle est affiché inactif et n'a pas été testé**.
- Un email transactionnel porte le tag = nom de l'événement et l'en-tête `X-Mailin-custom: event_id:<id>` (traçabilité dans les logs Brevo).

## 7. Transition depuis les anciens événements français

Quand `BREVO_OUTBOX_ENABLED=true`, l'application **cesse d'émettre** les anciens noms ci-dessous. Les **six parcours actifs** relevés dans le compte (#4 Onboarding candidat, #6 R01, #8 C03, #10 C06, #11 R04, #12 R10) utilisent ces noms : **ils ne se déclencheront plus** s'ils ne sont pas réorientés avant la bascule.

| Ancien | Nouveau | Attention |
|---|---|---|
| `compte_candidat_cree` / `compte_recruteur_active` | `signup_completed` | filtrer sur `role` |
| `test_adn_termine` | `adn_completed` | |
| `offre_publiee` | `offer_published` | `offre_id` désormais présent |
| `candidature_recue` | `application_received` | `candidat` vient de la candidature figée |
| `match_cree` | `match_created` | envoyé aux **deux** parties : filtrer sur `ROLE` pour séparer C06 (candidat) et R10 (recruteur) |
| `premier_message_envoye` | `first_message_sent` | `conversation_id` = ancien `match_id` |
| `abonnement_active` | `subscription_started` | |
| `abonnement_mis_a_jour` | `subscription_updated`, `plan_changed`, `subscription_reactivated` | |
| `resiliation_enregistree` | `subscription_cancel_scheduled` | |
| `abonnement_termine` | `subscription_ended` | |
| `like_recu` / `profil_consulte` / `swipe_effectue` | `like_received` / `profile_viewed` / `swipe_performed` | mêmes propriétés |

Problèmes déjà visibles dans le compte, à corriger dans Brevo indépendamment du code : le modèle #22 envoyé le 6 octobre (« Votre match avec attend toujours », « Bonjour , ») utilise des variables non fournies ; liens `__CTA_LIEN__` ; R10 attend 24 h mais annonce deux jours ; R04 envoie « offre publiée » immédiatement au lieu d'une relance à 5 jours.

## 8. Hors périmètre

- **Notifications push** web ou mobile : non implémentées. Ce raccordement ne produit que des événements et des emails.
- Aucun parcours Brevo n'est créé, modifié ou activé par ce code.
