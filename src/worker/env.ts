export interface Auth {
  identityId: string;
  tokenHash: string;
  activeProfileId: string;
  elevatedUntil: number;
  profile: { id: string; kind: "personal" | "business" | "ai"; handle: string; status: string; role: "owner" | "manager" };
  adminRole: "owner" | "admin" | "moderator" | null;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { auth: Auth | null };
};
