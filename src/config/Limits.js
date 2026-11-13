// One place for group-size limits (used by the optimiser, group rules, seats and what-if). Group size is NOT tied to any example
// number: any size from MIN to MAX works. MAX only exists to bound routing cost (Bike evaluates ~40 candidates x every participant)
// and the optimiser's work — raise it here if you ever need larger groups.
export const GROUP_LIMITS = Object.freeze({ min: 2, max: 12 });
