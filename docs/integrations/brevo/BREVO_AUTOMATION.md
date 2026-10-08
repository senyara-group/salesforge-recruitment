# Raccordement SwipSales → Brevo (technique et exploitation)

Documents liés :
- [`BREVO_CONTRAT_YANNIS.md`](BREVO_CONTRAT_YANNIS.md) : contrat de passation pour le responsable Brevo (noms d'événements, destinataires, variables, attributs, conditions), lisible sans connaître le code.
- [`CHECKLIST_PASSATION.md`](CHECKLIST_PASSATION.md) : qui fait quoi, décisions en attente, éléments non testés en conditions réelles.

Ce document décrit le fonctionnement, l'installation et les limites. Le code ne crée et n'active aucun parcours Brevo. Les nouveaux envois restent désactivés tant que les trois flags ne sont pas à `true`.

## Fichiers

| Rôle | Fichier |
|---|---|
| Migration (tables, triggers, fonctions) | [`backend/brevo_outbox_migration.sql`](../../../backend/brevo_outbox_migration.sql) |
| Règles et délais des relances | [`backend/utils/automationRules.js`](../../../backend/utils/automationRules.js) (`DELAYS`) |
| Planificateur | [`backend/utils/automationScheduler.js`](../../../backend/utils/automationScheduler.js) |
| Revalidation avant envoi | [`backend/utils/automationDelivery.js`](../../../backend/utils/automationDelivery.js) |
| Worker | [`backend/utils/brevoWorker.js`](../../../backend/utils/brevoWorker.js) |
| Job planifié | [`backend/scripts/run-brevo-automation.js`](../../../backend/scripts/run-brevo-automation.js) (`npm run brevo:run`) |
| Capture Stripe | [`backend/utils/stripeAutomation.js`](../../../backend/utils/stripeAutomation.js), [`backend/routes/stripe.js`](../../../backend/routes/stripe.js) |
| Anciennes émissions et bascule | [`backend/utils/brevoEvents.js`](../../../backend/utils/brevoEvents.js) |
| API navigateur (préférences, activité, interactions) | [`backend/routes/automation.js`](../../../backend/routes/automation.js), [`frontend/automation-tracking.js`](../../../frontend/automation-tracking.js) |
| Date de fin d'offre | [`backend/utils/offerExpiration.js`](../../../backend/utils/offerExpiration.js) |
| Variables d'environnement | [`backend/.env.example`](../../../backend/.env.example) |

## Architecture

- **Capture** : les inscriptions, profils, résultats ADN, publications, candidatures, statuts, matchs et messages sont capturés par des triggers SQL **dans la transaction métier**. Le webhook Stripe signé écrit ses événements avant d'acquitter. Un événement Stripe produit au plus un événement d'automatisation (`dedupe_key = stripe:<event.id>`).
- **File** : `brevo_outbox` conserve chaque événement, ses tentatives et son état (`event_delivered_at`, `email_delivered_at`, `delivered_at`, `discarded_at`, `last_error`). Tables et fonctions inaccessibles aux rôles `anon` / `authenticated`.
- **Planificateur** : calcule les relances des dix scénarios et les insère avec une clé de déduplication déterministe. **Tous les délais sont définis dans l'objet `DELAYS`** de `automationRules.js` ; Brevo ne doit pas ajouter d'attente sur ces événements.
- **Worker** : réserve 5 événements (verrou + jeton de bail), **revalide** chaque événement (consentement, candidature, offre, activité, réponse…), met à jour le contact, envoie l'événement puis éventuellement un email transactionnel. Chaque étape est enregistrée séparément : une reprise ne renvoie pas une étape déjà acceptée.
- **Erreurs** : nouvelle tentative avec délai croissant (30 s, 1 min, 2 min… plafonné à 24 h). Après 12 tentatives (~17 h), l'événement est marqué `discarded_at` avec `last_error = "max attempts: …"` et conservé pour inspection.
- **Fraîcheur** : une notification jamais acceptée par Brevo et plus ancienne que `BREVO_MAX_EVENT_AGE_HOURS` (72 h par défaut) est écartée (`last_error = "stale: …"`). Les triggers enregistrent dès l'installation de la migration, même worker arrêté : sans cette règle, l'activation enverrait en rafale des notifications vieilles de plusieurs jours. Les mises à jour de contact (`__contact_update`) ne sont pas concernées (elles relisent l'état courant), et un événement déjà accepté termine son étape email.
- **Garantie** : livraison **au moins une fois**. Un timeout après acceptation par Brevo peut produire un doublon ; `event_id` permet de le repérer. Brevo ne documente pas de déduplication des emails transactionnels : l'en-tête `Idempotency-Key` est transmis sans garantie, la vraie protection est le point de contrôle `email_delivered_at`. Les emails portent `X-Mailin-custom: event_id:<id>` et le tag = nom de l'événement.
- **Format Brevo** : l'API événements n'accepte que des valeurs simples dans `event_properties`. Les listes (`offres`, `candidats`) sont aplaties (`offre_1_poste`, `candidat_1_score`…) ; les `params` des modèles transactionnels gardent les listes.

## Choix de comportement à connaître

- `profile_updated` n'est émis que si une valeur suivie change réellement (une sauvegarde complète identique n'émet rien).
- `offer_first_application` tient compte des candidatures antérieures à l'installation.
- `profile_incomplete` attend 24 h après l'inscription, puis une fois par semaine.
- `compatible_offer_found` ne concerne que les offres publiées depuis moins de 48 h : une inscription aux relances ou une longue pause ne déclenche pas un événement par ancienne offre ; les offres plus anciennes alimentent `weekly_recommendations`.
- Un swipe de candidature enregistré (`swipes_meta.liked_offer_ids`) compte comme tentative aboutie, même sans ligne de candidature créée.
- `recruiter_message_unanswered` ne considère que les messages des 7 derniers jours postérieurs à l'installation, et n'est pas annulé par la candidature qui a créé la conversation.
- `adn_started` est émis à l'affichage réel du questionnaire ADN (après consentement et éligibilité), y compris si le module de suivi termine de se charger après l'ouverture.
- L'activité (`/api/automation/activity`) est enregistrée au plus une fois par heure par utilisateur.
- `ROLE` provient de `users.role`.
- Stripe : résiliation/réactivation déterminées par `previous_attributes` de l'événement ; `plan_changed` seulement entre deux formules payantes ; `billing_reason` transmis sur les factures.

## Données personnelles, consentement, anonymat

- **Consentement** : les dix relances exigent `automation_preferences.marketing_enabled = true`, **désactivé par défaut**, modifiable par l'utilisateur (page Compte du candidat, Paramètres du recruteur). Aucun consentement existant n'est importé. Conséquence : au lancement, seuls les utilisateurs qui cochent l'option reçoivent ces relances. Les rappels proches du service (`offer_expiring`, `saved_offer_expiring`, `recruiter_message_unanswered`, `application_abandoned`) sont aussi soumis à ce choix ; les traiter comme notifications de service est une décision produit/juridique, non prise par ce code.
- **Notifications de service** (candidature, statut, message, facturation) : envoyées sans condition de consentement marketing. Le contact Brevo est créé/mis à jour pour tout utilisateur concerné (prénom, nom, rôle, formule, score ADN, complétion).
- **Anonymat** (conforme à [`backend/ANONYMITY.md`](../../../backend/ANONYMITY.md)) : l'identité d'un candidat n'est transmise qu'au recruteur de l'offre à laquelle il a **volontairement** postulé, depuis la candidature figée (`snapshot`). Sinon : `Candidat anonyme`.
- **Minimisation** : jamais de contenu de message, de réponse ADN, de pièce jointe, de ville ni de CV. Les identifiants de candidats servent côté serveur mais **ne sont pas transmis à Brevo** ; `compatible_candidates_found` ne contient que des scores.
- Aucune donnée client ne choisit le destinataire : l'utilisateur vient de la session authentifiée ou de la base.

## Non-régression avant la bascule

Avec `BREVO_OUTBOX_ENABLED=false` (valeur par défaut) :
- les anciens événements français et attributs sont émis exactement comme avant ; les parcours Brevo actuels continuent de fonctionner ;
- la date de fin d'offre est masquée et refusée par l'API (503), les listes d'offres ne filtrent pas l'expiration ;
- la route `/api/automation/*` répond 503 ; le module navigateur ne fait rien ;
- si la migration est déjà appliquée, les triggers remplissent la file sans rien envoyer (les notifications de plus de 72 h seront écartées à l'activation).

Changements Stripe actifs **quel que soit le flag** (corrections, testées dans `stripeWebhookSubscriptions.test.js`) :
- un checkout non payé (`payment_status` ni `paid` ni `no_payment_required`) n'active plus l'abonnement ; `checkout.session.async_payment_succeeded` est traité comme le paiement confirmé ;
- un abonnement `trialing` est enregistré `actif` ; la date de fin lit aussi `items[0].current_period_end` (versions récentes de l'API Stripe) ;
- les erreurs d'écriture d'abonnement sont détectées et renvoient 500 (Stripe réessaie) au lieu d'un 400 silencieux ; une signature invalide renvoie toujours 400.

Avec le flag actif, une erreur de capture Brevo (file indisponible, migration absente…) **n'empêche pas** la mise à jour de l'abonnement : elle est appliquée, puis la réponse 500 fait réessayer Stripe pour la seule capture (idempotente).

**Éviter les doubles envois** :
- les anciens noms recouverts par la capture SQL/Stripe ne sont plus émis quand le flag est actif (liste dans le contrat, section 7) ;
- `BREVO_OUTBOX_ENABLED` doit avoir **la même valeur sur le serveur web et sur le job**. Serveur à `false` et job à `true` ⇒ anciens et nouveaux événements envoyés en parallèle ;
- un événement présent dans `BREVO_TRANSACTIONAL_TEMPLATES` ne doit pas aussi déclencher un email de parcours Brevo ;
- aucun autre envoi direct d'email n'existe dans le code (`utils/brevo.js#sendEmail` n'est appelé nulle part).

## Installation et recette

1. **Recette d'abord.** Sur une base de recette au schéma de production, appliquer `backend/brevo_outbox_migration.sql` (SQL editor Supabase). Transactionnelle et rejouable ; aucune notification historique. Les triggers enregistrent les nouveaux faits dès l'installation, même worker arrêté.
2. Déployer backend + frontend de la même révision, **trois flags à `false`**. `npm ci` (PGlite est une dépendance de développement).
3. Le responsable Brevo prépare attributs, parcours et modèles sur des contacts de recette selon le contrat, en réorientant les anciens noms français (les six parcours actifs ne se déclencheront plus après bascule sinon).
4. Dans Stripe (mode test), créer/vérifier l'endpoint webhook avec : `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_succeeded`, `invoice.payment_failed`.
5. En recette uniquement : `BREVO_OUTBOX_ENABLED=true` (captures applicatives, préférences, suivi d'interactions, date de fin d'offre) **sur le serveur web et le job**, puis `BREVO_AUTOMATION_ENABLED=true` (worker), puis `BREVO_SCHEDULER_ENABLED=true` (relances).
6. Planifier le job (voir ci-dessous).
7. Recetter les dix scénarios, leurs annulations, les rôles et l'anonymat ; vérifier dans Brevo l'événement **et** l'email délivré. Contrôler la file :
   ```sql
   select event_name, count(*) filter (where delivered_at is null and discarded_at is null) as en_attente,
          count(*) filter (where discarded_at is not null) as ecartes, max(last_error) as derniere_erreur
   from brevo_outbox group by event_name order by 1;
   ```
8. Après validation : même migration en production, déploiement, réorientation des parcours, activation des flags et des jobs. Consigner l'heure de bascule.

**Arrêt d'urgence** : `BREVO_AUTOMATION_ENABLED=false` sur le job (les faits restent en file ; au-delà de 72 h, les notifications seront écartées à la reprise). Ne pas supprimer triggers/tables sans plan de reprise.

## Exploitation du job (sans endpoint public)

Le worker n'est **pas** une route HTTP : c'est un processus court lancé par un planificateur, qui lit `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `BREVO_API_KEY`, `FRONTEND_URL` (HTTPS), les trois flags, et en option `BREVO_TRANSACTIONAL_TEMPLATES`, `BREVO_WORKER_BATCHES` (20 par défaut, lots de 5) et `BREVO_MAX_EVENT_AGE_HOURS` (72).

Sur Railway (hébergement actuel) : la configuration d'un fichier `railway*.json` prévaut sur le tableau de bord, et `railway.json` décrit le serveur web. Deux fichiers dédiés sont fournis, **inactifs tant qu'aucun service ne les utilise** :
- [`railway.brevo-worker.json`](../../../railway.brevo-worker.json) : `npm --prefix backend run brevo:run` chaque minute, sans redémarrage automatique. Service à configurer avec `BREVO_SCHEDULER_ENABLED=false` (worker seul).
- [`railway.brevo-scheduler.json`](../../../railway.brevo-scheduler.json) : même commande toutes les 15 minutes. Service à configurer avec `BREVO_SCHEDULER_ENABLED=true` (le calcul offres × candidats est coûteux).

Pour chacun : créer un service depuis le même dépôt, renseigner son *Config file path* (`/railway.brevo-worker.json` ou `/railway.brevo-scheduler.json`), copier les variables d'environnement, et **ne générer aucun domaine public**. Vérifier dans les journaux Railway qu'une exécution se termine bien (« Brevo automation disabled » tant que les flags sont à `false`).

Le processus se termine à la fin du lot. Code de sortie non nul : erreur du worker, ou du planificateur (le worker s'exécute quand même dans ce cas, pour ne pas retenir les notifications de service). Deux exécutions qui se chevauchent sont sans danger (baux exclusifs). Surveiller les logs du service et la requête de file ci-dessus.

## Limites connues

- Planificateur : traversée offres × candidats en mémoire à chaque passage ; à surveiller et à passer en SQL si la volumétrie augmente.
- `message_read` produit un événement par message lu.
- Pas de push web/mobile.
- Les 14 notifications de facturation du cahier des charges ne sont pas identifiées une à une (voir le contrat, section 5).

## Vérifications locales

`npm test` (dans `backend`) : taxonomie, syntaxe, HTML statique, tests unitaires. `test/brevoMigration.test.js` exécute la migration dans PGlite **sur un schéma reprenant les types réels des tables de production** (`test/fixtures/supabase_schema_snapshot.sql`, relevé via l'OpenAPI PostgREST le 8 octobre 2026) : réexécution, triggers, rollback, baux, permissions. `test/stripeWebhookSubscriptions.test.js` vérifie la route webhook, flag inactif et actif. Les autres tests simulent Brevo et Stripe.

Ces tests ne prouvent pas que la clé Brevo autorise les opérations, que les attributs existent avec le bon type, que les modèles sont actifs, ni que le job et le webhook sont déployés.

Références API : [événements Brevo](https://developers.brevo.com/reference/create-event), [emails transactionnels](https://developers.brevo.com/reference/send-transac-email).
