/** Build-time choice for the separately verified compatible fallback artifact.
 * No request, role, environment variable or operator flag can bypass it.
 * The fallback retains all current readers and dirty/pending evidence while
 * stopping derived generation/backfill; original business writes are separate.
 */
const generationEnabled=true;
export const journeyFactGenerationEnabled=()=>generationEnabled;
