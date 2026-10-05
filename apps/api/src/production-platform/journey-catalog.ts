import { JOURNEY_NODES } from "@dx-rework/contracts/digital-production-journey";
export { JOURNEY_NODES };
/** Original external-cutting task kind maps to the single whole-order cutting node. */
export function journeyDefinition(key:string) { return JOURNEY_NODES.find(node=>node.key===(key==="bulk_cutting_external"?"bulk_cutting":key)); }
