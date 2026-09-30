import {
  WorkTaskAssignablePeopleResponseSchema,
  type WorkTaskAssignablePeopleResponse,
} from "@dx-rework/contracts";

export type ParsedWorkTaskOptions = Readonly<{
  response: WorkTaskAssignablePeopleResponse;
  compatibilityMode: boolean;
}>;

const isLegacyPerson = (value: unknown): value is Readonly<{
  personId: string;
  displayName: string;
  personType: "internal" | "temporary";
}> => {
  if (!value || typeof value !== "object") return false;
  const person = value as Record<string, unknown>;
  return typeof person.personId === "string"
    && typeof person.displayName === "string"
    && (person.personType === "internal" || person.personType === "temporary")
    && person.eligibleExecutionKinds === undefined;
};

export const parseWorkTaskOptions = (value: unknown): ParsedWorkTaskOptions => {
  const current = WorkTaskAssignablePeopleResponseSchema.safeParse(value);
  if (current.success) return { response: current.data, compatibilityMode: false };

  if (!value || typeof value !== "object") {
    return {
      response: WorkTaskAssignablePeopleResponseSchema.parse(value),
      compatibilityMode: false,
    };
  }
  const people = (value as { people?: unknown }).people;
  if (!Array.isArray(people) || !people.every(isLegacyPerson)) {
    return {
      response: WorkTaskAssignablePeopleResponseSchema.parse(value),
      compatibilityMode: false,
    };
  }

  return {
    response: WorkTaskAssignablePeopleResponseSchema.parse({
      people: people.map((person) => ({
        ...person,
        eligibleExecutionKinds: ["worker"],
      })),
    }),
    compatibilityMode: true,
  };
};
