export const DREAM_PROMOTION_KEY = 'brain-memory:promote-dreams';
export async function readDreamPromotion(metadata) {
  return { promoteDreamsToMemory: (await metadata.get(DREAM_PROMOTION_KEY)) !== false };
}
export async function saveDreamPromotion(metadata, input) {
  if (!input || typeof input.promoteDreamsToMemory !== 'boolean') throw new Error('promote_dreams_to_memory_invalid');
  await metadata.set(DREAM_PROMOTION_KEY, input.promoteDreamsToMemory);
  return readDreamPromotion(metadata);
}
