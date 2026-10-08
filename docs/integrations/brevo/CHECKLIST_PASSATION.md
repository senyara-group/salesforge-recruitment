# Checklist de passation SwipSales → Brevo

Répartition : **Développement** (backend, Supabase, hébergement) / **Responsable Brevo** (attributs, parcours, modèles, campagnes). Le contrat d'événements est dans [BREVO_CONTRAT_YANNIS.md](BREVO_CONTRAT_YANNIS.md), le fonctionnement technique dans [BREVO_AUTOMATION.md](BREVO_AUTOMATION.md).

État au 8 octobre 2026 : code sur la branche `claude/brevo-automation` (PR brouillon), **non fusionné, non déployé, migration non appliquée, flags à `false`**.

## 1. Déjà développé dans SwipSales

- [x] File d'événements `brevo_outbox` avec triggers dans la transaction métier (inscription, profil, ADN, offre, candidature, statut, match, message).
- [x] Worker sans endpoint public : bail exclusif, revalidation avant envoi, reprises (12 tentatives), abandon des notifications de plus de 72 h, mise à jour de contact puis événement puis email optionnel.
- [x] Planificateur des relances des dix scénarios ; tous les délais dans `DELAYS` (`backend/utils/automationRules.js`).
- [x] Capture Stripe : abonnement, paiement réussi/échoué, résiliation, réactivation, changement de formule, fin, checkout démarré.
- [x] Préférence « emails et recommandations » (désactivée par défaut) : page Compte du candidat, Paramètres du recruteur ; lien `lien_preferences` dans chaque événement.
- [x] Suivi navigateur : consultation d'offre (2 s visible), tentative de candidature, offre enregistrée, activité (1×/h), ouverture du test ADN.
- [x] Date de fin d'offre facultative, fermeture automatique et refus des candidatures après expiration.
- [x] Envoi transactionnel optionnel par ID de modèle (`BREVO_TRANSACTIONAL_TEMPLATES`), relances marketing exclues.
- [x] Bascule par flag : anciens événements français inchangés tant que `BREVO_OUTBOX_ENABLED=false`.
- [x] Fichiers de cron Railway (`railway.brevo-worker.json`, `railway.brevo-scheduler.json`), inactifs tant qu'aucun service ne les référence.
- [x] Tests locaux (PGlite sur les types réels du schéma, Brevo et Stripe simulés).

### Correspondance scénarios → événements (vérifiée dans le code)

| Scénario | Événement(s) | Calculé par |
|---|---|---|
| 1 Profil incomplet | `profile_incomplete` (+ `profile_updated` pour les sorties) | planificateur |
| 2 Nouvelle offre compatible | `compatible_offer_found` | planificateur |
| 3 Offre consultée sans candidature | `offer_viewed_without_application` | planificateur (suivi navigateur) |
| 4 Candidature interrompue | `application_abandoned` (envoi par swipe tenté, non abouti) | planificateur (suivi navigateur) |
| 5 Suivi de candidature | `application_submitted`, `application_received`, `application_status_changed`, `offer_first_application` | trigger SQL |
| 6 Messages / absence de réponse | `message_received`, `message_sent`, `message_read`, `first_message_sent`, `recruiter_message_unanswered` | trigger SQL + planificateur |
| 7 Recommandations hebdomadaires | `weekly_recommendations` | planificateur |
| 8 Inactivité | `user_inactive` (7, 14, 30 jours) | planificateur (suivi navigateur) |
| 9 Nouveaux profils compatibles | `compatible_candidates_found` | planificateur |
| 10 Expiration des offres | `offer_expiring`, `saved_offer_expiring` | planificateur |

## 2. Développement : reste à faire (backend, Supabase, hébergement)

- [ ] Relire puis fusionner la PR (après validation).
- [ ] Appliquer `backend/brevo_outbox_migration.sql` sur la base de **recette** (SQL editor Supabase), puis vérifier : `select count(*) from brevo_outbox;` = 0 et présence des fonctions `claim_brevo_events`, `enqueue_brevo_event`.
- [ ] Déployer backend + frontend en recette, **trois flags à `false`** ; vérifier que les anciens parcours Brevo reçoivent toujours leurs événements français.
- [ ] Ajouter `BREVO_API_KEY` (clé avec droits contacts, événements, emails transactionnels) aux variables de recette ; `FRONTEND_URL` en HTTPS.
- [ ] Créer les deux services cron Railway (worker toutes les 5 min — minimum Railway —, planificateur toutes les 15 min) avec les mêmes variables, sans domaine public.
- [ ] Stripe test : créer l'endpoint webhook (aucun n'existe sur le compte test au 8 octobre) avec les 6 événements listés dans `BREVO_AUTOMATION.md` ; reporter `STRIPE_WEBHOOK_SECRET`.
- [ ] Recette puis production : dérouler la **procédure de bascule anti-doublons** (`BREVO_AUTOMATION.md`) : flag `BREVO_OUTBOX_ENABLED=true` sur le web et les jobs → noter T → aperçu → écarter les 6 événements historiques déjà notifiés (trace conservée) → vérifier → feu vert au responsable Brevo → `BREVO_AUTOMATION_ENABLED=true` → `BREVO_SCHEDULER_ENABLED=true`.
- [ ] Fournir au responsable Brevo des comptes de recette candidat et recruteur (adresses de test).
- [ ] Surveiller la file (requête dans `BREVO_AUTOMATION.md`) et les journaux des jobs pendant la recette.
- [ ] Recevoir du responsable Brevo la liste des modèles à envoyer depuis l'application (`BREVO_TRANSACTIONAL_TEMPLATES`) et la renseigner.
- [ ] Production, après validation : migration → déploiement → procédure de bascule → jobs. Consigner T, les nombres écartés et l'heure d'activation.

## 3. Responsable Brevo : à créer ou configurer

- [ ] Créer les attributs de contact avec leurs types (contrat, section 4).
- [ ] Construire les parcours des dix scénarios sur les événements du contrat, en **inactif**, sans ajouter de délai d'attente aux relances.
- [ ] Dans chaque parcours de relance, condition `AUTOMATION_MARKETING_ALLOWED = true` avant l'email.
- [ ] Séparer candidats et recruteurs avec l'attribut `ROLE` (notamment `match_created`, envoyé aux deux).
- [ ] Préparer les modèles avec les variables exactes du contrat et un texte par défaut pour les valeurs absentes (`score`, `prenom`, `entreprise`…).
- [ ] Décider pour chaque notification : envoi par parcours **ou** par l'application (modèle transactionnel), jamais les deux ; communiquer les IDs des modèles transactionnels.
- [ ] Préparer la réorientation des six parcours actifs (#4, #6, #8, #10, #11, #12) vers les nouveaux noms ; identifier les anciens parcours déclenchés par attribut/date à désactiver à la bascule.
- [ ] À la bascule : désactiver les anciens parcours remplacés dès le passage du flag ; **n'activer les nouveaux parcours qu'après le feu vert technique** (événements historiques écartés).
- [ ] Corriger les modèles défectueux déjà constatés (#22 « Bonjour , », liens `__CTA_LIEN__`, délais R10/R04).
- [ ] Lister les 14 notifications de facturation attendues en regard des 9 événements Stripe disponibles (contrat, section 5).
- [ ] Recette sur contacts de test : événement reçu, entrée dans le parcours, email délivré, variables remplies, sortie de parcours.

## 4. Décisions produit encore nécessaires

- [ ] Rappels de service soumis ou non à l'opt-in marketing : `offer_expiring`, `saved_offer_expiring`, `recruiter_message_unanswered`, `application_abandoned` (aujourd'hui soumis, donc reçus seulement par ceux qui cochent l'option).
- [ ] Faut-il proposer l'option aux utilisateurs existants (bannière, email de consentement) ? Aucun consentement n'est importé.
- [ ] Politique après un paiement échoué (délai de grâce, suspension) : aucune date n'est transmise tant qu'elle n'est pas définie.
- [ ] Statuts de candidature qui déclenchent un email (tous produisent un événement).
- [ ] Notifications de facturation non couvertes à développer ou non : fin d'essai, carte expirante, rappel de renouvellement, remboursement.
- [ ] Date de la bascule et fenêtre de coordination développement / Brevo.
- [ ] Push web/mobile : hors périmètre, à décider séparément.

## 5. Non testé en conditions réelles

- [ ] Migration sur une vraie base Supabase (testée uniquement dans PGlite, sur les types relevés en production ; les contraintes CHECK/UNIQUE sont supposées présentes).
- [ ] Appels réels à l'API Brevo (contacts, événements, emails) : clé absente de l'environnement local.
- [ ] Types d'attributs Brevo, activation et variables des modèles (le modèle `SWIP-C13-1` #55 est affiché inactif).
- [ ] Webhooks Stripe réels (aucun endpoint sur le compte test) ; versions récentes de l'API Stripe (`invoice.parent…`).
- [ ] Exécution des jobs cron sur Railway.
- [ ] Suivi navigateur sur mobile et en conditions réseau dégradées.
- [ ] Volumétrie du planificateur (offres × candidats).
- [ ] Délivrabilité des emails.
