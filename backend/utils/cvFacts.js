const FACT_STATUS = Object.freeze({
  CONFIRMED: 'CONFIRMED',
  DECLARED: 'DECLARED',
  INFERRED: 'INFERRED',
  VERIFY: 'VERIFY',
  MISSING: 'MISSING',
});
const MAX_DATE_RANGES = 40;

const TECHNOLOGIES = Object.freeze([
  ['React Native', /\breact\s+native\b/i, 'mobile'],
  ['React', /\breact(?:\.js|js)?\b/i, 'frontend'],
  ['Node.js', /\bnode(?:\.js|js)?\b/i, 'backend'],
  ['JavaScript', /\bjavascript\b/i, 'frontend'],
  ['TypeScript', /\btypescript\b/i, 'frontend'],
  ['Supabase', /\bsupabase\b/i, 'database'],
  ['PostgreSQL', /\bpostgres(?:ql)?\b/i, 'database'],
  ['AWS', /\baws\b|amazon web services/i, 'cloud'],
  ['Azure', /\bazure\b/i, 'cloud'],
  ['GCP', /\bgcp\b|google cloud/i, 'cloud'],
  ['Railway', /\brailway\b/i, 'deployment'],
  ['Vercel', /\bvercel\b/i, 'deployment'],
  ['Docker', /\bdocker\b/i, 'deployment'],
  ['Kubernetes', /\bkubernetes\b|\bk8s\b/i, 'deployment'],
  ['CI/CD', /\bci\s*\/\s*cd\b|intégration continue|continuous integration/i, 'ci_cd'],
  ['API', /\bapi(?:s)?\b|\brest(?:ful)?\b/i, 'api'],
  ['OAuth', /\boauth\b/i, 'auth_security'],
  ['RLS', /\brls\b|row level security/i, 'auth_security'],
  ['Stripe', /\bstripe\b/i, 'payments'],
]);

function normalize(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function headingKey(line) {
  const heading = normalize(line).trim().replace(/[:|]/g, '').replace(/\s+/g, ' ');
  const parts = heading.split(' ').filter(Boolean);
  return parts.length >= 3 && parts.every((part) => /^[a-z]$/.test(part))
    ? parts.join('')
    : heading;
}

function extractSections(sourceText) {
  const sections = { experience: [], skills: [] };
  let current = '';
  for (const line of String(sourceText || '').split(/\r?\n/)) {
    const heading = headingKey(line);
    if (/^(experiences?( professionnelles?)?|experiencesprofessionnelles?|parcours professionnel|emplois?)$/.test(heading)) current = 'experience';
    else if (/^(competences?|stack technique|stacktechnique|technologies?|outils)$/.test(heading)) current = 'skills';
    else if (/^(formation|diplomes?|education|langues?|interets?|profil|resume)$/.test(heading)) current = '';
    else if (current) sections[current].push(line);
  }
  return { experience: sections.experience.join('\n'), skills: sections.skills.join('\n') };
}

function extractDateRanges(sourceText, now = new Date()) {
  const text = String(sourceText || '');
  const currentYear = now.getUTCFullYear() + now.getUTCMonth() / 12;
  const ranges = [];
  const rangePattern = /\b((?:19|20)\d{2})\s*(?:[-–—]|à|au)\s*((?:19|20)\d{2}|présent|present|aujourd'hui|actuel(?:lement)?)\b/gi;
  for (const match of text.matchAll(rangePattern)) {
    const start = Number(match[1]);
    const ongoing = !/^\d{4}$/.test(match[2]);
    const end = ongoing ? currentYear : Number(match[2]);
    if (start >= 1950 && start <= currentYear && end >= start && end - start <= 60) {
      ranges.push({ start, end, ongoing, source: match[0], position: match.index });
    }
  }
  const sincePattern = /\bdepuis\s+((?:19|20)\d{2})\b/gi;
  for (const match of text.matchAll(sincePattern)) {
    const start = Number(match[1]);
    if (start >= 1950 && start <= currentYear && !ranges.some((range) => range.ongoing && range.start === start)) {
      ranges.push({ start, end: currentYear, ongoing: true, source: match[0], position: match.index });
    }
  }
  return ranges.sort((a, b) => a.position - b.position).slice(0, MAX_DATE_RANGES);
}

function timelineFacts(ranges) {
  if (!ranges.length) return null;
  const ordered = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  let overlaps = 0;
  for (const range of ordered) {
    const last = merged.at(-1);
    if (!last || range.start > last.end) merged.push({ start: range.start, end: range.end });
    else {
      if (range.start < last.end) overlaps += 1;
      last.end = Math.max(last.end, range.end);
    }
  }
  const duration = merged.reduce((sum, range) => sum + Math.max(0, range.end - range.start), 0);
  const gaps = merged.slice(1).map((range, index) => range.start - merged[index].end).filter((gap) => gap >= 1.5);
  const documentYears = ranges.map((range) => range.start);
  const ascending = documentYears.length >= 2 && documentYears.every((year, index) => index === 0 || year >= documentYears[index - 1]);
  const descending = documentYears.length >= 2 && documentYears.every((year, index) => index === 0 || year <= documentYears[index - 1]);
  return {
    status: FACT_STATUS.INFERRED,
    approximate_years: { min: Math.max(0, Math.floor(duration)), max: Math.max(0, Math.ceil(duration)) },
    wording: Math.floor(duration) === Math.ceil(duration) ? `environ ${Math.round(duration)} ans de parcours daté` : `environ ${Math.floor(duration)} à ${Math.ceil(duration)} ans de parcours daté`,
    merged_periods: merged.map((range) => ({ start_year: range.start, end_year: Math.ceil(range.end) })),
    overlaps_detected: overlaps,
    significant_gaps_years: gaps.map((gap) => Math.floor(gap)),
    document_order: ascending ? 'ascending' : descending ? 'descending' : 'mixed_or_unknown',
  };
}

function technologyFacts(sourceText, targetText) {
  const source = String(sourceText || '');
  const target = String(targetText || '');
  const sections = extractSections(source);
  const confirmed = [];
  const verify = [];
  for (const [name, pattern, category] of TECHNOLOGIES) {
    const present = pattern.test(source);
    if (present) {
      const inExperience = Boolean(sections.experience) && pattern.test(sections.experience);
      const onlyListed = Boolean(sections.skills) && pattern.test(sections.skills) && !inExperience;
      confirmed.push({ name, category, status: FACT_STATUS.CONFIRMED, evidence: inExperience ? 'experience' : onlyListed ? 'skills_list_only' : 'cv_unspecified' });
    } else if (pattern.test(target)) {
      verify.push({ name, category, status: FACT_STATUS.VERIFY, reason: 'présent dans la cible mais absent du CV' });
    }
  }
  return { confirmed, verify };
}

function inferredStrengths(sourceText, timeline, technologies) {
  const text = String(sourceText || '');
  const normalized = normalize(text);
  const categories = new Set(technologies.confirmed.map((technology) => technology.category));
  const strengths = [];
  const supportPosition = normalized.search(/\b(help\s*desk|support(?: n[12])?|assistance)\b/);
  const developmentPosition = normalized.search(/\b(developpeur|developpement|full[- ]?stack)\b/);
  const explicitTransition = /support[\s\S]{0,120}(?:vers|puis|→)[\s\S]{0,120}develop/i.test(normalized);
  const orderedTransition = supportPosition >= 0 && developmentPosition >= 0 && timeline && (
    (timeline.document_order === 'ascending' && supportPosition < developmentPosition)
    || (timeline.document_order === 'descending' && developmentPosition < supportPosition)
  );
  if (explicitTransition || orderedTransition) strengths.push({ status: FACT_STATUS.INFERRED, type: 'career_progression', wording: 'Évolution factuelle du support vers le développement', evidence: ['support', 'développement', timeline?.document_order || 'explicit_transition'] });
  if (categories.has('frontend') && categories.has('mobile')) strengths.push({ status: FACT_STATUS.INFERRED, type: 'web_mobile_coverage', wording: 'Expérience couvrant le web et le mobile', evidence: ['frontend', 'mobile'] });
  if (categories.has('frontend') && categories.has('backend') && categories.has('database')) strengths.push({ status: FACT_STATUS.INFERRED, type: 'full_stack_coverage', wording: 'Couverture front, back et base de données', evidence: ['frontend', 'backend', 'database'] });
  if (categories.has('cloud')) strengths.push({ status: FACT_STATUS.INFERRED, type: 'cloud_exposure', wording: 'Technologies cloud explicitement citées', evidence: ['cloud'] });
  if (categories.has('auth_security')) strengths.push({ status: FACT_STATUS.INFERRED, type: 'security_exposure', wording: 'Sécurité ou authentification explicitement citée', evidence: ['auth_security'] });
  if (categories.has('deployment')) strengths.push({ status: FACT_STATUS.INFERRED, type: 'deployment_exposure', wording: 'Outils de déploiement explicitement cités', evidence: ['deployment'] });
  return strengths;
}

function declaredFact(value) {
  return value === '' || value === null || value === undefined ? null : { status: FACT_STATUS.DECLARED, value };
}

function buildCvFacts({ sourceText, experienceYears, targetRole, sector, offerText, now } = {}) {
  const sections = extractSections(sourceText);
  const ranges = extractDateRanges(sections.experience || sourceText, now);
  const timeline = timelineFacts(ranges);
  const technologies = technologyFacts(sourceText, `${targetRole || ''}\n${sector || ''}\n${offerText || ''}`);
  const declaredYears = Number(experienceYears);
  const experienceAmbiguity = Number.isFinite(declaredYears) && timeline
    && (declaredYears < timeline.approximate_years.min - 1 || declaredYears > timeline.approximate_years.max + 1)
    ? {
        status: FACT_STATUS.VERIFY,
        declared_years: declaredYears,
        dated_path_years: timeline.approximate_years,
        reason: 'La durée déclarée et le parcours daté peuvent décrire des périmètres différents ; conserver les deux sans en déduire une durée de spécialité.',
      }
    : null;
  return {
    version: 1,
    source_priority: ['DECLARED', 'CONFIRMED', 'INFERRED', 'VERIFY', 'MISSING'],
    declared: {
      experience_years: declaredFact(experienceYears),
      target_role: declaredFact(targetRole),
      sector: declaredFact(sector),
      job_description: declaredFact(offerText),
    },
    confirmed: {
      date_ranges: ranges.map((range) => ({ status: FACT_STATUS.CONFIRMED, value: range.source })),
      technologies: technologies.confirmed,
    },
    inferred: {
      timeline,
      strengths: inferredStrengths(sourceText, timeline, technologies),
    },
    verify: { technologies: technologies.verify, experience_years: experienceAmbiguity },
    missing: {
      rule: { status: FACT_STATUS.MISSING, value: 'Toute métrique métier absente des entrées reste manquante ou [À COMPLÉTER].' },
    },
  };
}

module.exports = { FACT_STATUS, MAX_DATE_RANGES, TECHNOLOGIES, extractDateRanges, timelineFacts, technologyFacts, inferredStrengths, buildCvFacts };
