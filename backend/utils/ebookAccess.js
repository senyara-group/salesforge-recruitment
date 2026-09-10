const EBOOK_ACCESS_LIMITS = Object.freeze({
  freemium: 3,
  carriere: 8,
  carriere_coaching: 15,
});

function normalizedEbookPlan(plan) {
  const normalized = String(plan || 'freemium').trim().toLowerCase();
  return Object.hasOwn(EBOOK_ACCESS_LIMITS, normalized) ? normalized : 'freemium';
}

function ebookAccessForPlan(plan, totalCount) {
  const normalizedPlan = normalizedEbookPlan(plan);
  const total = Math.max(0, Number(totalCount) || 0);
  return {
    plan: normalizedPlan,
    availableCount: Math.min(EBOOK_ACCESS_LIMITS[normalizedPlan], total),
    totalCount: total,
  };
}

async function accessibleEbooks(catalog, plan, createSignedUrl) {
  const access = ebookAccessForPlan(plan, catalog.length);
  const allowedCatalog = catalog.slice(0, access.availableCount);
  const ressources = await Promise.all(allowedCatalog.map(async (ebook, index) => {
    const { data } = await createSignedUrl(ebook.file);
    return {
      id: index,
      titre: ebook.titre,
      description: ebook.desc,
      categorie: ebook.categorie,
      url: data?.signedUrl || null,
    };
  }));
  return { ...access, ressources };
}

module.exports = { EBOOK_ACCESS_LIMITS, normalizedEbookPlan, ebookAccessForPlan, accessibleEbooks };
