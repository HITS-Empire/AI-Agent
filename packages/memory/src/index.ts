import pg from "pg";

export * from "./migrations";
export * from "./rrf";
export * from "./shortTerm";
export * from "./longTerm";
export * from "./profile";
export * from "./usage";
export * from "./tools";
export * from "./extractFacts";

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}
