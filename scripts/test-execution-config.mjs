// One runtime authority; both Vitest configurations and metadata read this.
export const testExecutionConfig=Object.freeze({
 workers:Object.freeze({nonDatabase:1,postgres:1,longCorrectness:2}),
 // User-approved correctness allowance; business SLA/performance assertions are independent.
 correctnessTimeoutMs:100000,
});
