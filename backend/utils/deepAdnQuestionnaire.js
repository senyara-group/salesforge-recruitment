const crypto = require('crypto');

const QUESTIONNAIRE_VERSION = 'yannis-48-v1';
const SCORING_VERSION = 'blocks-linear-v1';

const BLOCKS = Object.freeze([
  { id: 'B1', label: 'Profil chasseur ou éleveur', low: 'Profil éleveur', mid: 'Cycle complet', high: 'Profil chasseur' },
  { id: 'B2', label: 'Résistance au refus', low: 'Récupération progressive après un échec', high: 'Récupération rapide après un échec' },
  { id: 'B3', label: 'Style de closing', low: "Closing d’accompagnement", high: 'Closing direct' },
  { id: 'B4', label: 'Rapport au variable et au risque', low: 'Recherche de sécurité', high: 'À l’aise avec le risque et le variable' },
  { id: 'B5', label: 'Méthode et pilotage', low: 'Fonctionnement intuitif', high: 'Rigueur de processus installée' },
  { id: 'B6', label: 'Écoute et découverte', low: 'Tendance à présenter rapidement', high: 'Découverte approfondie' },
]);

function q(id, prompt, options) {
  return Object.freeze({ id, blockId: id.slice(0, 2), prompt, options: Object.freeze(options.map(([text, weight], index) => Object.freeze({ id: `${id}_O${index + 1}`, text, weight }))) });
}

const QUESTIONS = Object.freeze([
  q('B1_S01', 'On vous confie deux missions et vous devez en choisir une. Laquelle prenez-vous ?', [['Ouvrir un territoire vierge, aucun client, tout à construire',4],['Reprendre un portefeuille de 30 comptes en sommeil à réactiver',3],['Développer 15 comptes actifs mais sous-exploités',2],['Gérer 8 comptes stratégiques déjà bien installés',1]]),
  q('B1_S02', 'Lundi matin, 9h. Votre semaine est vide. Par quoi commencez-vous ?', [['Une session de prospection à froid de deux heures',4],["Un tour d’appels sur vos prospects tièdes du mois dernier",3],['Un point sur vos affaires en cours pour les faire avancer',2],['Un appel de courtoisie à vos trois meilleurs clients',1]]),
  q('B1_S03', 'Votre manager vous annonce que votre variable sera calculé sur un seul indicateur. Lequel préférez-vous ?', [['Le nombre de nouveaux clients signés',4],["Le chiffre d’affaires total généré",3],['La croissance de votre portefeuille existant',2],['Le taux de renouvellement de vos contrats',1]]),
  q('B1_S04', 'Un client historique et un prospect important veulent tous deux un rendez-vous jeudi. Vous ne pouvez en honorer qu’un.', [['Le prospect, le client comprendra',4],['Le prospect, et vous appelez le client pour reporter en expliquant',3],['Le client, un prospect se rappelle plus facilement',2],['Le client, la relation existante passe avant',1]]),
  q('B1_S05', 'Vous avez 45 minutes libres entre deux rendez-vous. Que faites-vous ?', [['Vous appelez des entreprises repérées le matin même',4],["Vous relancez des prospects qui n’ont pas répondu",3],['Vous mettez à jour vos dossiers en cours',2],['Vous préparez le rendez-vous suivant en détail',1]]),
  q('B1_S06', 'Quel scénario vous donne le plus de satisfaction ?', [['Signer un client qui vous a dit non deux fois',4],["Décrocher un rendez-vous avec une entreprise inaccessible",3],["Faire passer un client de 20 à 60 K€ de commande annuelle",2],['Renouveler un contrat majeur pour trois ans',1]]),
  q('B1_S07', 'On vous propose de changer de secteur pour un marché que vous ne connaissez pas du tout.', [['Vous acceptez immédiatement, tout s’apprend',4],['Vous acceptez si on vous laisse six mois de montée en compétence',3],['Vous hésitez, votre valeur vient de votre connaissance du marché actuel',2],['Vous refusez, repartir de zéro n’a pas de sens',1]]),
  q('B1_S08', 'Comment décririez-vous votre pipeline idéal ?', [['Beaucoup d’affaires, dont une partie n’aboutira pas',4],['Un flux constant de nouvelles opportunités',3],['Peu d’affaires mais très bien qualifiées',2],['Un portefeuille stable avec des renouvellements prévisibles',1]]),

  q('B2_S09', 'Il est 16h. Vous avez passé 24 appels : 19 barrages, 4 refus secs, 1 « rappelez en septembre ». Il vous reste une heure.', [['Vous continuez à appeler jusqu’à 17h comme prévu',4],['Vous basculez sur du mail et du LinkedIn, moins frontal',2],['Vous rappelez deux prospects tièdes de la semaine dernière',3],['Vous passez sur vos dossiers en cours, vous reprendrez demain',1]]),
  q('B2_S10', 'Un prospect vous raccroche au nez après trois secondes. Que se passe-t-il dans la minute qui suit ?', [['Vous composez le numéro suivant',4],['Vous notez ce qui s’est passé puis vous enchaînez',3],['Vous prenez deux minutes pour souffler',2],['Vous vous demandez si votre accroche est la bonne et vous la retravaillez',1]]),
  q('B2_S11', 'Vous perdez une affaire sur laquelle vous travailliez depuis quatre mois. Votre première action ?', [['Vous appelez le client pour comprendre précisément ce qui a fait la différence',4],['Vous en parlez à votre manager pour analyser ensemble',3],['Vous relancez votre prospection pour compenser',2],['Vous passez à autre chose, ça arrive',1]]),
  q('B2_S12', 'Troisième semaine consécutive sans signature. Comment évolue votre activité ?', [['Vous augmentez votre volume d’appels',4],['Vous maintenez exactement le même rythme',3],['Vous vous concentrez sur vos dossiers les plus avancés',2],['Vous levez le pied sur la prospection le temps que ça reparte',1]]),
  q('B2_S13', 'Vous devez appeler un prospect qui vous a envoyé promener sèchement il y a trois mois. Le contexte a changé.', [['Vous l’appelez sans hésiter',4],['Vous l’appelez après avoir préparé une nouvelle accroche',3],['Vous lui écrivez plutôt que d’appeler',2],['Vous le laissez de côté, il y a assez d’autres prospects',1]]),
  q('B2_S14', 'Un prospect vous dit : « franchement votre solution ne m’intéresse pas du tout ». Que répondez-vous ?', [['Qu’est-ce qui vous fait dire ça ? Je préfère comprendre',4],['Je comprends. Qu’est-ce qui vous conviendrait mieux ?',3],['Très bien, merci de votre franchise, bonne journée',2],['Vous vous excusez du dérangement et vous raccrochez',1]]),
  q('B2_S15', 'Le vendredi soir après une semaine à zéro résultat, à quoi pensez-vous ?', [['Au nombre d’appels que vous avez passés, qui produiront plus tard',4],['Aux deux ou trois pistes qui semblent prometteuses',3],['À ce que vous auriez pu faire différemment',2],['À la pression que vous aurez lundi',1]]),
  q('B2_S16', 'Votre manager vous dit devant l’équipe que vos résultats du mois sont insuffisants.', [['Vous demandez un point en tête à tête pour construire un plan',4],['Vous présentez vos chiffres d’activité pour montrer le travail fourni',3],['Vous encaissez et vous vous remettez au travail',2],['Vous le vivez mal pendant plusieurs jours',1]]),

  q('B3_S17', 'Fin de rendez-vous. Le client a été positif et dit : « c’est très intéressant, je vais en parler en interne ».', [['Très bien. Qu’est-ce qui vous ferait dire oui après cette discussion interne ?',4],['Qui allez-vous voir, et est-ce que je peux vous aider à préparer ?',3],['Parfait, je vous envoie la proposition et je vous rappelle jeudi',2],['Très bien, revenez vers moi quand vous voulez',1]]),
  q('B3_S18', 'Vous devez annoncer un prix nettement supérieur à ce que le client imaginait. Comment procédez-vous ?', [['Vous l’annoncez directement puis vous vous taisez',4],['Vous rappelez le coût de sa situation actuelle, puis vous annoncez',3],['Vous présentez trois formules et le prix apparaît dans le tableau',2],['Vous l’envoyez par écrit après le rendez-vous',1]]),
  q('B3_S19', 'Vous venez de poser votre question de closing. Le client ne répond pas et regarde ses notes. Cinq secondes passent.', [['Vous attendez sans rien dire',4],['Vous attendez encore un peu puis vous demandez ce qui le fait hésiter',3],['Vous reprenez un argument pour relancer',2],['Vous proposez de lui laisser du temps pour réfléchir',1]]),
  q('B3_S20', 'Le client demande une remise de 15 % pour signer aujourd’hui.', [['Vous proposez 8 % contre un engagement de 24 mois',4],['Vous demandez d’abord ce qui justifie ce chiffre de son côté',3],['Vous réduisez le périmètre pour tenir son budget sans baisser le tarif',3],['Vous accordez la remise, l’affaire est importante',1]]),
  q('B3_S21', 'À quel moment abordez-vous le budget dans un premier rendez-vous ?', [['Dans les dix premières minutes, pour qualifier',4],['Au milieu, après avoir compris le besoin',3],['À la fin, en même temps que la proposition',2],['Jamais au premier rendez-vous',1]]),
  q('B3_S22', 'Le client dit : « je vais réfléchir ». Vous n’avez aucune information de plus.', [['Réfléchir à quoi précisément ? Il reste un point qui vous gêne ?',4],['Bien sûr. On se rappelle mardi pour en reparler ?',3],['Je vous envoie un récapitulatif pour votre réflexion',2],['Prenez le temps qu’il vous faut',1]]),
  q('B3_S23', 'Vous êtes en rendez-vous et vous réalisez que votre interlocuteur ne décide pas.', [['Vous demandez à rencontrer le décideur avant d’aller plus loin',4],['Vous continuez et vous proposez une réunion à trois ensuite',3],['Vous continuez normalement, il fera remonter',2],['Vous écourtez le rendez-vous',1]]),
  q('B3_S24', 'Comment terminez-vous un rendez-vous qui s’est bien passé mais sans décision ?', [['Avec une date de décision fixée par le client',4],['Avec un prochain rendez-vous calé dans l’agenda',3],['Avec un engagement d’envoyer la proposition sous 48h',2],['En le remerciant et en restant à sa disposition',1]]),

  q('B4_S25', 'Deux offres identiques en total annuel. Laquelle prenez-vous ?', [['28 K€ de fixe et variable déplafonné',4],['34 K€ de fixe et variable plafonné à 26 K€',3],['42 K€ de fixe et 18 K€ de variable cible',2],['52 K€ de fixe et 8 K€ de prime annuelle',1]]),
  q('B4_S26', 'Nous sommes le 20 du mois. Savez-vous où vous en êtes de votre objectif ?', [['Au chiffre près, vous le suivez chaque jour',4],['À peu près, vous le regardez chaque semaine',3],['Approximativement, vous avez une idée',2],['Vous le découvrez en fin de mois',1]]),
  q('B4_S27', 'On vous annonce un objectif que vous jugez très ambitieux pour l’année.', [['Vous êtes stimulé, vous voulez le battre',4],['Vous demandez à comprendre comment il a été construit',3],['Vous acceptez mais vous négociez les moyens',2],['Vous demandez qu’il soit revu à la baisse',1]]),
  q('B4_S28', 'Avant de signer votre contrat, que faites-vous du plan de commissionnement ?', [['Vous le lisez ligne à ligne et vous posez des questions sur les seuils',4],['Vous le lisez et vous vérifiez le taux et le plafond',3],['Vous le parcourez rapidement',2],['Vous faites confiance à ce qui a été dit oralement',1]]),
  q('B4_S29', 'Votre variable du mois dépend d’une signature incertaine. Comment le vivez-vous ?', [['C’est le jeu, ça fait partie du métier',4],['Vous relancez pour sécuriser mais ça ne vous empêche pas de dormir',3],['Ça vous préoccupe une bonne partie du mois',2],['Vous n’aimez pas cette incertitude',1]]),
  q('B4_S30', 'On vous propose de passer sur un poste rémunéré à 80 % en variable.', [['Vous acceptez si le potentiel est réel',4],['Vous acceptez avec un fixe garanti les six premiers mois',3],['Vous demandez à voir les résultats des commerciaux en place',2],['Vous refusez, c’est trop risqué',1]]),
  q('B4_S31', 'Vous avez explosé votre objectif en octobre. Que faites-vous en novembre ?', [['Vous continuez au même rythme pour battre le record annuel',4],['Vous continuez normalement',3],['Vous commencez à préparer votre pipeline de janvier',3],['Vous levez un peu le pied, l’année est faite',1]]),
  q('B4_S32', 'Comment vous fixez-vous des objectifs ?', [['Vous vous en fixez de personnels, plus élevés que ceux de l’entreprise',4],['Vous découpez l’objectif entreprise en objectifs hebdomadaires',3],['Vous suivez l’objectif fixé par votre manager',2],['Vous vous concentrez sur le travail, les chiffres suivent',1]]),

  q('B5_S33', 'Il est 8h30 lundi. Quelle est votre première action de la semaine ?', [['Un point écrit sur votre pipeline et vos priorités de la semaine',4],['Vous regardez votre agenda et vous préparez vos rendez-vous',3],['Vous ouvrez votre boîte mail',2],['Vous rappelez les prospects qui ont laissé un message',1]]),
  q('B5_S34', 'Vous sortez d’un rendez-vous client important. Quand notez-vous ce qui s’est dit ?', [['Dans les cinq minutes, dans votre voiture ou juste après',4],['Dans l’heure, en revenant au bureau',3],['Le soir même',2],['En fin de semaine, quand vous mettez tout à jour',1]]),
  q('B5_S35', 'Combien d’affaires de votre pipeline n’ont aucune prochaine action datée ?', [['Aucune, c’est une règle chez vous',4],['Une ou deux',3],['Quelques-unes, celles qui sont en attente',2],['Vous ne fonctionnez pas comme ça',1]]),
  q('B5_S36', 'Votre taux de transformation du rendez-vous à la signature ?', [['Vous donnez le chiffre exact immédiatement',4],['Vous donnez une fourchette assez précise',3],['Vous avez une idée approximative',2],['Vous ne l’avez jamais calculé',1]]),
  q('B5_S37', 'Vous avez sept tâches urgentes ce matin. Comment décidez-vous par quoi commencer ?', [['Par ce qui rapproche le plus une affaire de la signature',4],['Par ce qui a la plus grosse valeur potentielle',3],['Par ce qui est le plus rapide à traiter',2],['Dans l’ordre où elles sont arrivées',1]]),
  q('B5_S38', 'Un prospect intéressé vous a demandé de le rappeler dans trois semaines. Comment le gérez-vous ?', [['Rappel programmé dans le CRM avec le contexte noté',4],['Rappel dans votre agenda avec une note',3],['Noté dans votre carnet',2],['Vous vous en souviendrez',1]]),
  q('B5_S39', 'Comment préparez-vous un rendez-vous important ?', [['Recherche sur l’entreprise, hypothèses de besoin, questions écrites à l’avance',4],['Vous regardez leur site et le profil de votre interlocuteur',3],['Vous relisez vos notes du dernier échange',2],['Vous improvisez, c’est votre force',1]]),
  q('B5_S40', 'À quel moment identifiez-vous qui signe réellement dans l’entreprise ?', [['Dès le premier échange, vous posez la question',4],['Au deuxième rendez-vous',3],['Au moment d’envoyer la proposition',2],['Quand ça bloque et que vous cherchez pourquoi',1]]),

  q('B6_S41', 'Dans un premier rendez-vous d’une heure, combien de temps parlez-vous ?', [['Environ 20 minutes, le client parle le reste',4],['Environ la moitié',3],['Une quarantaine de minutes, vous avez beaucoup à présenter',2],['L’essentiel, c’est vous qui menez',1]]),
  q('B6_S42', 'Le client vous décrit un problème que votre solution résout parfaitement. Que faites-vous ?', [['Vous creusez : depuis quand, combien ça coûte, qu’ont-ils déjà essayé',4],['Vous reformulez pour vérifier votre compréhension',3],['Vous enchaînez sur la fonctionnalité qui répond à ça',2],['Vous lancez votre démonstration, c’est le moment',1]]),
  q('B6_S43', 'Le client dit : « c’est compliqué en ce moment chez nous ». Votre réaction ?', [['Compliqué comment ? Racontez-moi',4],['Je comprends, beaucoup de nos clients vivent ça',2],['Justement, c’est ce qu’on aide à résoudre',1],['Qu’est-ce qui a changé récemment ?',3]]),
  q('B6_S44', 'Un silence de quatre secondes s’installe après une question que vous avez posée.', [['Vous attendez, il réfléchit',4],['Vous attendez puis vous reformulez la question',3],['Vous précisez votre question',2],['Vous enchaînez sur autre chose',1]]),
  q('B6_S45', 'Comment rédigez-vous une proposition commerciale ?', [['En reprenant les mots exacts du client sur son besoin',4],['En repartant de vos notes de découverte',3],['À partir de votre modèle, adapté au contexte',2],['Vous adaptez votre modèle standard',1]]),
  q('B6_S46', 'Vous réalisez en rendez-vous que votre solution ne convient pas vraiment au besoin.', [['Vous le dites et vous orientez vers autre chose',4],['Vous le dites et vous cherchez si un autre angle existe',3],['Vous présentez quand même, il jugera',2],['Vous mettez en avant ce qui correspond le mieux',1]]),
  q('B6_S47', 'Le client vous objecte quelque chose. Votre premier réflexe ?', [['Vous posez une question pour comprendre ce qu’il y a derrière',4],['Vous reformulez son objection avant de répondre',3],['Vous répondez avec l’argument que vous connaissez',2],['Vous rassurez immédiatement',1]]),
  q('B6_S48', 'Que cherchez-vous à savoir sur votre interlocuteur, au-delà de l’entreprise ?', [['Ce que ce projet représente pour lui personnellement',4],['Son rôle exact et son pouvoir de décision',3],['Son parcours et son ancienneté',2],['L’essentiel, c’est le besoin de l’entreprise',1]]),
]);

const QUESTION_BY_ID = new Map(QUESTIONS.map((question) => [question.id, question]));

function shuffled(values, randomInt = (max) => crypto.randomInt(max)) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const selected = randomInt(index + 1);
    [result[index], result[selected]] = [result[selected], result[index]];
  }
  return result;
}

function createPresentation(randomInt) {
  return QUESTIONS.map((question) => ({
    question_id: question.id,
    option_ids: shuffled(question.options.map((option) => option.id), randomInt),
  }));
}

function publicQuestionnaire(presentation) {
  const orderByQuestion = new Map(presentation.map((item) => [item.question_id, item.option_ids]));
  return {
    questionnaire_version: QUESTIONNAIRE_VERSION,
    scoring_version: SCORING_VERSION,
    blocks: BLOCKS.map((block) => ({
      id: block.id,
      label: block.label,
      questions: QUESTIONS.filter((question) => question.blockId === block.id).map((question) => ({
        id: question.id,
        text: question.prompt,
        options: (orderByQuestion.get(question.id) || []).map((optionId) => {
          const option = question.options.find((candidate) => candidate.id === optionId);
          return { id: option.id, text: option.text };
        }),
      })),
    })),
  };
}

function validateAnswer(questionId, optionId) {
  const question = QUESTION_BY_ID.get(questionId);
  if (!question) throw Object.assign(new Error('Question inconnue'), { code: 'UNKNOWN_QUESTION' });
  const option = question.options.find((candidate) => candidate.id === optionId);
  if (!option) throw Object.assign(new Error('Option inconnue pour cette question'), { code: 'UNKNOWN_OPTION' });
  return { question, option };
}

function normalizeBlockScore(rawTotal) {
  return Math.max(0, Math.min(100, Math.round(((Number(rawTotal) - 8) / 24) * 100)));
}

function scoreAnswers(answers, presentation = []) {
  if (!Array.isArray(answers)) throw new Error('Réponses invalides');
  const seen = new Set();
  const selected = answers.map((answer) => {
    if (seen.has(answer.question_id)) throw Object.assign(new Error('Réponse en double'), { code: 'DUPLICATE_ANSWER' });
    seen.add(answer.question_id);
    const validated = validateAnswer(answer.question_id, answer.option_id);
    return { ...validated, questionId: answer.question_id, optionId: answer.option_id };
  });
  if (selected.length !== QUESTIONS.length || QUESTIONS.some((question) => !seen.has(question.id))) {
    throw Object.assign(new Error('Les 48 situations doivent être complétées'), { code: 'INCOMPLETE_ASSESSMENT' });
  }

  const blocks = BLOCKS.map((block) => {
    const blockAnswers = selected.filter((answer) => answer.question.blockId === block.id);
    const raw = blockAnswers.reduce((sum, answer) => sum + answer.option.weight, 0);
    const score = normalizeBlockScore(raw);
    const profile = block.id === 'B1' && score >= 40 && score <= 60 ? block.mid : score > 60 ? block.high : block.low;
    return { id: block.id, label: block.label, score: Math.max(0, Math.min(100, score)), profile };
  });

  const orderByQuestion = new Map(presentation.map((item) => [item.question_id, item.option_ids]));
  const alwaysFirst = selected.every((answer) => orderByQuestion.get(answer.questionId)?.[0] === answer.optionId);
  const allMaximum = selected.every((answer) => answer.option.weight === 4);
  const flags = [
    ...(alwaysFirst ? ['always_first_displayed_option'] : []),
    ...(allMaximum ? ['all_blocks_maximum'] : []),
  ];
  return {
    questionnaire_version: QUESTIONNAIRE_VERSION,
    scoring_version: SCORING_VERSION,
    blocks,
    consistency: { coherent: flags.length === 0, flags, message: flags.length ? 'Certaines réponses paraissent très uniformes. Vous pourrez repasser le test selon les conditions de votre formule.' : '' },
  };
}

module.exports = {
  QUESTIONNAIRE_VERSION, SCORING_VERSION, BLOCKS, QUESTIONS,
  createPresentation, publicQuestionnaire, validateAnswer, normalizeBlockScore, scoreAnswers,
};
