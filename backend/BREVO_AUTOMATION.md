# Raccordement SwipSales → Brevo

Cette livraison prépare les événements nécessaires aux dix scénarios candidats et recruteurs. Elle ne crée et n'active aucun parcours Brevo. Les nouveaux envois restent désactivés tant que les variables d'activation ne sont pas configurées.

## Répartition application / Brevo

SwipSales enregistre les faits, identifie le destinataire, calcule les données et prépare les relances. Yannis configure les contenus, les conditions et les envois dans Brevo. Un événement transmis ne prouve pas qu'un email a été délivré : vérifier séparément l'entrée dans le parcours, l'envoi et la réception.

Les inscriptions, mises à jour de profil, résultats ADN, publications, candidatures, statuts et messages sont capturés par des triggers SQL dans la transaction métier. La file `brevo_outbox` conserve les événements et les tentatives. Les paiements sont capturés depuis le webhook Stripe signé, avant son acquittement. Les erreurs de persistance provoquent une réponse 500 pour que Stripe réessaie.

Le worker utilise des réservations avec verrouillage et un jeton de propriété. Il actualise le contact avant l'événement, puis traite éventuellement un modèle transactionnel. Il conserve séparément l'acceptation de l'événement et celle de l'email. Les erreurs sont réessayées avec un délai croissant, plafonné à 24 heures. Un timeout Brevo après acceptation peut encore produire un événement en double : la livraison est **au moins une fois**, pas exactement une fois. Utiliser `event_id` pour les contrôles de doublons. Une clé d'idempotence est également fournie pour les emails transactionnels.

## Contrat des dix scénarios

1. **Profil incomplet** : `profile_incomplete`, avec `completion` calculé depuis les sept éléments de la checklist actuelle (photo, identité, ville, CV, lettre, ADN, compétences). Une relance par semaine tant que le profil est incomplet. `profile_updated` transmet aussi le pourcentage courant.
2. **Nouvelle offre compatible** : `compatible_offer_found`, avec `offre_id`, `poste`, `entreprise`, `score`. Ne concerne que les offres créées après l'installation. Le score utilise les axes ADN courts et les pondérations réelles du recruteur ; aucun score fictif de 70/85/95 n'est repris. Les choix déclarés de poste, secteur et contrat sont respectés. Aucun événement sans axe mesurable ; seuil de 70 %.
3. **Offre consultée sans candidature** : `offer_viewed_without_application`, avec `offre_id`, `poste`, `entreprise`, après 24 heures. La carte au premier plan doit être visible pendant deux secondes. Le chargement d'une pile d'offres ne compte pas comme consultation. Une seule relance par première consultation enregistrée ; aucune après un passage ou une candidature.
4. **Tentative de candidature interrompue** : `application_abandoned`, après 24 heures. Le produit actuel envoie directement une candidature par swipe et n'a pas de formulaire multiétape. Ici, l'événement signifie qu'une tentative a commencé sans candidature enregistrée. Une candidature réussie annule la relance.
5. **Suivi de candidature** : `application_submitted` pour le candidat ; `application_received` pour le recruteur ; `application_status_changed` pour le candidat avec `application_id`, `offre_id`, `poste`, `entreprise`, `previous_status`, `statut`. Brancher sur `vu`, `contacte`, `repondu`, `entretien`, `offre`, `embauche`, `refusee` ou `retiree`. `contacte` désigne le contact enregistré, pas une décision d'embauche. Le statut entretien ne contient pas de date ou de créneau : aucun calendrier d'entretien n'est ajouté.
6. **Messages** : `message_received` à chaque message, pour son destinataire, avec `message_id`, `conversation_id`, le contexte offre et le lien. Aucun contenu de message n'est envoyé à Brevo. `message_sent`, `message_read` et `first_message_sent` permettent les sorties de parcours. `recruiter_message_unanswered` après 48 heures si le dernier message vient du recruteur et que le candidat n'a pas répondu. Pas de relance d'une candidature refusée, retirée ou embauchée.
7. **Recommandations** : `weekly_recommendations`, avec `offres` (jusqu'à cinq offres actuellement valides, titres, entreprises, scores) et `nb`. Première occurrence après une semaine d'installation, puis une par semaine. Les offres déjà postulées, passées, expirées ou sans score mesurable sont exclues.
8. **Inactivité** : `user_inactive`, avec `days` (7, 14 ou 30), `nb` et jusqu'à cinq offres compatibles créées depuis la dernière activité. Le suivi d'activité couvre les sessions authentifiées, y compris OAuth ; une page laissée en arrière-plan ne maintient pas indéfiniment une activité. Une reprise d'activité annule les relances en attente. Un worker démarré après 30 jours ne rejoue pas les rappels de 7 et 14 jours.
9. **Nouveaux profils compatibles** : `compatible_candidates_found` pour le propriétaire de l'offre, avec `offre_id`, `poste`, `nb` et `candidats` (IDs et scores, jusqu'à vingt détails). Les nouvelles découvertes sont groupées par offre, par lots de cent maximum. Une découverte candidat/offre est enregistrée une seule fois, dans la même transaction que l'événement. Les profils existant avant l'installation ne sont concernés qu'après une mise à jour. Aucune identité, adresse, réponse ADN ou pièce jointe de sourcing passif n'est transmise.
10. **Expiration** : `offer_expiring` pour le recruteur et `saved_offer_expiring` pour le candidat, dans les trois derniers jours. `date_fin`, `offre_id`, `poste` sont transmis. Le recruteur choisit une date facultative dans son formulaire ; aucune durée n'est inventée pour les offres existantes. Les offres expirées sont exclues des listes et refusées lors d'une candidature. Le bouton d'enregistrement sur une carte conserve les offres à surveiller.

Les relances marketing exigent le choix explicite `marketing_enabled` dans les préférences. Il est désactivé par défaut ; les consentements existants ne sont pas inventés ni importés automatiquement. L'application expose ce choix dans le profil candidat / le compte recruteur. Avant chaque livraison, le worker vérifie le choix courant et les conditions pertinentes : candidature déjà envoyée, profil terminé, offre retirée, activité reprise, réponse reçue, offre désenregistrée, compatibilité modifiée. Les recommandations sont à nouveau filtrées avant émission.

**Ne pas ajouter un second délai de 24/48 heures dans Brevo aux événements de relance** : SwipSales a déjà attendu. Pour une boucle Brevo basée sur `profile_updated`, utiliser les événements de sortie et vérifier les attributs avant chaque envoi. Chaque email doit avoir un seul responsable d'envoi, soit parcours Brevo, soit mapping transactionnel applicatif.

## Autres événements et transition

- `signup_completed` : rôle `CANDIDAT` ou `RECRUTEUR`.
- `adn_started` : première étape réellement ouverte, consentement ADN vérifié côté serveur ; dédoublonné par utilisateur et jour.
- `adn_completed` : résultat enregistré, `score`.
- `offer_published` : publication ou réactivation, `offre_id`, `poste`, `expires_at`.
- `offer_first_application` : première candidature reçue sur l'offre.
- `offer_limit_reached` : quota de publication atteint, `plan`, `limit` ; une fois par jour et formule.
- `match_created` : création d'une ligne de conversation/match, aux deux participants. Ce fait est distinct d'une nouvelle recommandation compatible et ne certifie pas à lui seul un intérêt réciproque.
- `like_received`, `profile_viewed`, `swipe_performed` reprennent les faits déjà émis ; leurs compteurs historiques sont conservés. Un like de sourcing n'est pas nécessairement rattaché à une offre.

Lorsque `BREVO_OUTBOX_ENABLED=false`, les émissions historiques françaises restent inchangées. Lorsque ce flag passe à `true`, les émissions historiques recouvrant les captures transactionnelles sont supprimées et le nouveau contrat anglais prend le relais. Les événements non recouvrants passent dans la file. Adapter les déclencheurs Brevo et arrêter les anciennes versions avant la bascule ; ne pas laisser deux parcours envoyer la même notification.

Le nouveau contrat regroupe la consultation et les autres étapes sous `application_status_changed` : il ne prétend pas reproduire chaque nom d'un ancien pack. Une embauche se repère avec `statut=embauche`. La distinction doit être communiquée à Yannis avant activation.

## Facturation Stripe

Le webhook prépare `subscription_started`, `subscription_updated`, `subscription_cancel_scheduled`, `subscription_reactivated`, `subscription_ended`, `plan_changed`, `payment_succeeded` et `payment_failed`. Le checkout authentifié prépare `checkout_started`.

Les factures sont rattachées via les métadonnées du véritable abonnement Stripe, jamais par rapprochement d'une adresse email. Les formes historiques `invoice.subscription` et récentes `invoice.parent.subscription_details.subscription` sont acceptées. Un checkout encore impayé n'active plus l'abonnement ; `checkout.session.async_payment_succeeded` couvre sa confirmation ultérieure. Le webhook vérifie désormais les erreurs de sauvegarde des abonnements.

Paramètres de paiement : `plan`, `facturation`, `montant` en euros (chaîne à deux décimales pour la devise EUR actuelle), `amount_minor`, `currency`, `numero_paiement`, `invoice_id`, `payment_url`, `stripe_event_id`. Un montant d'une autre devise n'est pas présenté comme des euros. Le lien de paiement provient de la facture Stripe signée. Aucune date de suspension commerciale n'est inventée : une éventuelle politique de grâce/suspension reste à définir avant un modèle qui la promet.

Le secret Stripe doit recevoir au moins : `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_succeeded`, `invoice.payment_failed`. Vérifier cette sélection dans Stripe en préproduction ; le code seul ne l'active pas.

## Attributs et modèles à préparer dans Brevo

Créer/vérifier les types avant le premier envoi : `ROLE`, `PLAN`, `FACTURATION`, `STATUT_ABO` (texte), `PRENOM`, `NOM` (texte), `PROFIL_COMPLETION`, `SCORE_ADN` (nombre), `AUTOMATION_MARKETING_ALLOWED`, `TEST_ADN_TERMINE`, `OFFRE_PUBLIEE` (booléen), `DERNIERE_ACTIVITE` (texte ISO). Les attributs historiques `ABONNEMENT_PLAN`, `ABONNEMENT_STATUT`, `ABONNEMENT_DATE_FIN`, `NB_LIKES_7J`, `NB_CONSULTATIONS_7J` restent possibles selon les événements existants. Si les types en production diffèrent, adapter le contrat avant activation.

Tous les événements portent `event_id`, `occurred_at`, `lien` vers l'application authentifiée et `lien_preferences`. Les événements enrichis portent le prénom du destinataire lorsqu'il existe. Le lien de préférences ouvre le bon espace puis ses préférences ; la connexion reste requise. Les emails au recruteur n'utilisent que l'identité du snapshot volontaire de candidature pour cette offre, jamais l'identité courante d'un profil passif.

Les IDs réels des modèles doivent être validés dans le compte Brevo. Aucun ID ou modèle actif n'est supposé. `BREVO_TRANSACTIONAL_TEMPLATES={}` signifie événements seuls. Pour l'envoi applicatif, renseigner un objet JSON associant un événement à son ID numérique. Une clé comme `application_status_changed:entretien` permet un modèle par statut et a priorité sur `application_status_changed`. Les événements autorisés sont déclarés dans `utils/automationDelivery.js`. Les relances marketing ne peuvent pas être envoyées via ce mapping transactionnel.

Si un modèle est configuré dans ce mapping, son parcours Brevo ne doit pas envoyer le même email. Tester les `params` sur un contact de recette : prénom, entreprise, poste, statut, montant et liens. La présence d'un modèle dans Brevo ne garantit pas son activation ou le remplissage de ses variables. Le nombre exact de notifications facturation à raccorder dépend de la liste des modèles validés ; aucun faux « 14/14 opérationnels » n'est annoncé.

Le raccordement fournit les événements et la possibilité d'envoi email. Il n'ajoute pas de fournisseur de push natif/mobile ni de service worker de push web. Les badges et conversations existants continuent de fonctionner. Un push système supplémentaire demande le canal, les permissions et les appareils destinataires.

## Installation et recette

1. Sur une base de recette représentant le schéma actuel, appliquer `brevo_outbox_migration.sql`. Il nécessite les tables produit existantes et leurs colonnes utilisées par les routes. La migration est transactionnelle et rejouable ; elle ne produit pas de notifications historiques. Les triggers commencent toutefois à enregistrer les nouveaux faits dès son installation, même tant que le worker est arrêté.
2. Déployer le backend et les deux espaces frontend de la même livraison, avec les trois flags à `false`. Utiliser `npm ci` ; PGlite est une dépendance de développement pour la recette SQL locale.
3. Yannis prépare le contrat, les attributs et parcours sur des contacts de recette, avec une seule méthode d'envoi par notification. Adapter les anciens noms français avant bascule. Contrôler les abonnements Stripe en mode test et la sélection des événements du webhook.
4. Activer `BREVO_OUTBOX_ENABLED=true` sur l'environnement de recette uniquement : captures supplémentaires, préférences et interactions. Puis `BREVO_AUTOMATION_ENABLED=true` pour le worker ; `BREVO_SCHEDULER_ENABLED=true` pour les relances.
5. Configurer un job serveur exécutant `npm run brevo:run` depuis `backend`, par exemple toutes les minutes. Il doit disposer de `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `BREVO_API_KEY`, d'un `FRONTEND_URL` HTTPS et des mêmes flags. Ne pas exposer ce job comme endpoint public. `BREVO_WORKER_BATCHES` limite les lots de cinq événements par exécution (20 par défaut). Surveiller le retard de file ; les notifications arrivent au passage du worker, pas synchroniquement dans la requête utilisateur.
6. Recetter les dix scénarios, leurs annulations, les rôles et l'anonymat. Vérifier dans Brevo les événements et les emails réellement délivrés, puis obtenir la validation de production. Aucun test local de cette livraison n'envoie de vrais emails ou ne déclenche de paiement.
7. Après validation, appliquer la même migration en production, déployer le code, ajuster les déclencheurs Brevo, puis activer les flags et le job. Consigner l'heure de bascule et prévenir Yannis après observation d'un événement réel autorisé. Pour arrêter les nouveaux envois, mettre `BREVO_AUTOMATION_ENABLED=false` ; conserver les données en attente jusqu'à décision de reprise. Ne pas supprimer les triggers/tables sans plan de reprise des événements.

Les événements anciens de la file ne sont pas purgés automatiquement : arrêter le worker conserve les faits. Avant une reprise après un long arrêt, inspecter la file et décider du sort des notifications de service historiques. Les relances marketing sont revalidées, mais le consentement et les données peuvent toujours évoluer juste après la vérification ; les parcours doivent également vérifier `AUTOMATION_MARKETING_ALLOWED` avant chaque email.

La lecture du planificateur est paginée, sans troncature silencieuse au plafond Supabase de 1 000 lignes. Son calcul de compatibilité reste une traversée offres × candidats : adapter le traitement par lots/SQL et surveiller la durée si la volumétrie augmente.

## Vérifications locales

`npm test` contrôle la taxonomie, la syntaxe backend/frontend, les liens HTML et les tests unitaires. Les tests PGlite exécutent la migration PostgreSQL, sa réexécution, les triggers, un rollback métier, les réservations et les permissions. Les autres tests simulent Brevo et Stripe, les reprises partielles, les destinataires, les annulations de relance et l'anonymat.

Ces tests ne prouvent pas que la base de production possède exactement ce schéma, que la clé Brevo permet les opérations, que les modèles sont actifs, que les types d'attributs concordent, ni que le job et les webhooks sont déployés. La recette connectée reste nécessaire.

Références API : [événements Brevo](https://developers.brevo.com/reference/create-event), [emails transactionnels et modèles](https://developers.brevo.com/reference/send-transac-email).
