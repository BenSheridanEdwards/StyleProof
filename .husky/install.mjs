try {
  const { default: husky } = await import('husky');
  console.log(husky());
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !String(error.message).includes("'husky'")) {
    throw error;
  }
  console.log('husky is unavailable; package build completed without installing repository hooks');
}
