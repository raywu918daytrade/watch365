export function loadProjectEnv(path) {
  try {
    process.loadEnvFile(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
