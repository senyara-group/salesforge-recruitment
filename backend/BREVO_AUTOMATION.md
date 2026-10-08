# Raccordement SwipSales → Brevo (technique et exploitation)

Le contrat fonctionnel destiné à la configuration Brevo (noms d'événements, destinataires, variables, attributs, conditions) est dans [`BREVO_CONTRAT_YANNIS.md`](BREVO_CONTRAT_YANNIS.md). Ce document décrit le fonctionnement, l'installation et les limites.

Le code ne crée et n'active aucun parcours Brevo. Les nouveaux envois restent désactivés tant que les trois flags ne sont pas à `true`.

## Architecture

- **Capture** : les inscriptions, profils, résultats ADN, publications, candidatures, statuts, matchs et messages sont capturés par des triggers SQL **dans la transaction métier** (`brevo_outbox_migration.sql`). Le webhook Stripe signé écrit ses événements avant d'acquitter ; une erreur de persistance renvoie 500 pour que Stripe réessaie. Un événement Stripe produit au plus un événement d'automatisation (`dedupe_key = stripe:<event.id>`).
- **File** : `brevo_outbox` conserve chaque événement, ses tentatives et son état (`event_delivered_at`, `email_delivered_at`, `delivered_at`, `discarded_at`, `last_error`). Tables et fonctions inaccessibles aux rôles `anon` / `authenticated`.
- **Planificateur** (`utils/automationScheduler.js`, `utils/automationRules.js`) : calcule les relances des dix scénarios et les insère avec une clé de déduplication déterministe.
- **Worker** (`utils/brevoWorker.js`) : réserve 5 événements (verrou + jeton de bail), **revalide** chaque événement (`utils/automationDelivery.js` : consentement, candidature, offre, activité, réponse…), met à jour le contact, envoie l'événement puis éventuellement un email transactionnel. Chaque étape est enregistrée séparément : une reprise ne renvoie pas une étape déjà acceptée.
- **Erreurs** : nouvelle tentative avec délai croissant (30 s, 1 min, 2 min… plafonné à 24 h). Après 12 tentatives (~17 h), l'événement est marqué `discarded_at` avec `last_error = "max attempts: …"` et conservé pour inspection.
- **Garantie** : livraison **au moins une fois**. Un timeout après acceptation par Brevo peut produire un doublon ; `event_id` permet de le repérer. Brevo ne documente pas de déduplication des emails transactionnels : l'en-tête `Idempotency-Key` est transmis sans garantie, la vraie protection est le point de contrôle `email_delivered_at`.
- **Format Brevo** : l'API événements n'accepte que des valeurs simples dans `event_properties`. Les listes (`offres`, `candidats`) sont aplaties (`offre_1_poste`…) ; les `params` des modèles transactionnels gardent les listes.

## Choix de comportement à connaître

- `profile_updated` n'est émis que si une valeur suivie change réellement (une sauvegarde complète identique n'émet rien).
- `offer_first_application` tient compte des candidatures antérieures à l'installation.
- `profile_incomplete` attend 24 h après l'inscription, puis une fois par semaine.
- `compatible_offer_found` ne concerne que les offres publiées depuis moins de 48 h : une inscription aux relances ou une longue pause ne déclenche pas un événement par ancienne offre ; les offres plus anciennes alimentent `weekly_recommendations`.
- Un swipe de candidature enregistré (`swipes_meta.liked_offer_ids`) compte comme tentative aboutie, même sans ligne de candidature créée.
- `recruiter_message_unanswered` ne considère que les messages des 7 derniers jours postérieurs à l'installation, et n'est pas annulé par la candidature qui a créé la conversation.
- L'activité (`/api/automation/activity`) est enregistrée au plus une fois par heure par utilisateur.
- `ROLE` provient de `users.role`.
- Stripe : résiliation/réactivation déterminées par `previous_attributes` de l'événement ; `plan_changed` seulement entre deux formules payantes ; `billing_reason` transmis sur les factures.

## Consentement

Les dix relances exigent `automation_preferences.marketing_enabled = true`, **désactivé par défaut**, modifiable par l'utilisateur (page Compte du candidat, Paramètres du recruteur). Aucun consentement existant n'est importé. Conséquence : au lancement, seuls les utilisateurs qui cochent l'option reçoivent ces relances. Les rappels proches du service (`offer_expiring`, `saved_offer_expiring`, `recruiter_message_unanswered`, `application_abandoned`) sont aussi soumis à ce choix ; les traiter comme notifications de service est une décision produit/juridique à prendre explicitement, elle n'est pas prise par ce code.

## Installation et recette

1. **Recette d'abord.** Sur une base de recette au schéma de production, appliquer `brevo_outbox_migration.sql` (SQL editor Supabase). Transactionnelle et rejouable ; aucune notification historique. Les triggers enregistrent les nouveaux faits dès l'installation, même worker arrêté.
2. Déployer backend + frontend de la même révision, **trois flags à `false`**. `npm ci` (PGlite est une dépendance de développement).
3. Yannis prépare attributs, parcours et modèles sur des contacts de recette selon le contrat, en réorientant les anciens noms français (les six parcours actifs ne se déclencheront plus après bascule sinon).
4. Dans Stripe (mode test), vérifier que l'endpoint webhook reçoit : `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_succeeded`, `invoice.payment_failed`.
5. En recette uniquement : `BREVO_OUTBOX_ENABLED=true` (captures applicatives, préférences, suivi d'interactions, date de fin d'offre), puis `BREVO_AUTOMATION_ENABLED=true` (worker), puis `BREVO_SCHEDULER_ENABLED=true` (relances).
6. Planifier `npm run brevo:run` depuis `backend` (variables : `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `BREVO_API_KEY`, `FRONTEND_URL` en HTTPS, mêmes flags, éventuellement `BREVO_TRANSACTIONAL_TEMPLATES`). Recommandé : **un job toutes les minutes avec `BREVO_SCHEDULER_ENABLED=false`** (worker seul) et **un job toutes les 15 minutes avec `BREVO_SCHEDULER_ENABLED=true`** (le calcul offres × candidats est coûteux). Ne jamais l'exposer comme endpoint public. `BREVO_WORKER_BATCHES` (20 par défaut) limite les lots de 5 par exécution.
7. Recetter les dix scénarios, leurs annulations, les rôles et l'anonymat ; vérifier dans Brevo l'événement **et** l'email délivré. Contrôler la file :
   ```sql
   select event_name, count(*) filter (where delivered_at is null and discarded_at is null) as en_attente,
          count(*) filter (where discarded_at is not null) as ecartes, max(last_error) as derniere_erreur
   from brevo_outbox group by event_name order by 1;
   ```
8. Après validation : même migration en production, déploiement, réorientation des parcours, activation des flags et des jobs. Consigner l'heure de bascule.

**Arrêt d'urgence** : `BREVO_AUTOMATION_ENABLED=false` (les faits restent en file). Avant une reprise après un long arrêt, inspecter la file : les notifications de service anciennes ne sont pas purgées automatiquement. Ne pas supprimer triggers/tables sans plan de reprise.

## Limites connues

- Planificateur : traversée offres × candidats en mémoire à chaque passage ; à surveiller et à passer en SQL si la volumétrie augmente.
- `message_read` produit un événement par message lu.
- Pas de push web/mobile.
- Les 14 notifications de facturation du cahier des charges ne sont pas identifiées une à une (voir le contrat, section 5).

## Vérifications locales

`npm test` : taxonomie, syntaxe, HTML statique, tests unitaires. `test/brevoMigration.test.js` exécute la migration dans PGlite **sur un schéma reprenant les types réels des tables de production** (`test/fixtures/supabase_schema_snapshot.sql`, relevé via l'OpenAPI PostgREST le 8 octobre 2026) : réexécution, triggers, rollback, baux, permissions. Les autres tests simulent Brevo et Stripe.

Ces tests ne prouvent pas que la clé Brevo autorise les opérations, que les attributs existent avec le bon type, que les modèles sont actifs, ni que le job et le webhook sont déployés.

Références API : [événements Brevo](https://developers.brevo.com/reference/create-event), [emails transactionnels](https://developers.brevo.com/reference/send-transac-email).
