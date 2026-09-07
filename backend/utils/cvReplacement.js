async function finalizeCvReplacement({
  updateProfile,
  removeFile,
  newFile,
  previousFile,
  onCleanupError = () => {},
}) {
  let profile;
  try {
    profile = await updateProfile();
  } catch (error) {
    try { await removeFile(newFile); }
    catch (cleanupError) { onCleanupError('new', cleanupError); }
    throw error;
  }

  if (previousFile?.path && previousFile.path !== newFile.path) {
    try { await removeFile(previousFile); }
    catch (cleanupError) { onCleanupError('previous', cleanupError); }
  }
  return profile;
}

module.exports = { finalizeCvReplacement };
