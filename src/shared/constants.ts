export const POST_MAX_CHARS = 500;
export const BIO_MAX_CHARS = 280;
export const DISPLAY_NAME_MAX = 50;
export const MESSAGE_MAX_CHARS = 2000;
export const MAX_MEDIA_PER_POST = 4;
export const MEDIA_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const IMAGE_MAX_BYTES = 15 * 1024 * 1024;
export const VIDEO_MAX_BYTES = 90 * 1024 * 1024; // stays under Workers' 100 MB request body limit
export const THUMB_MAX_BYTES = 600 * 1024;
export const PROFILES_PER_IDENTITY = 10;
export const PIN_MIN = 4;
export const PIN_MAX = 12;
export const HANDLE_RE = /^[A-Za-z0-9_]{3,20}$/;
export const DEFAULT_VISIBILITY = 50;

export const ALLOWED_IMAGE_MIME = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
export const ALLOWED_VIDEO_MIME = ["video/mp4", "video/webm", "video/quicktime"] as const;

export interface MilestoneDef {
  level: number;
  threshold: number;
  name: string;
  material: string;
}

/** Follower milestones. Thresholds are a product requirement — do not change without migration. */
export const MILESTONES: readonly MilestoneDef[] = [
  { level: 1, threshold: 5_000, name: "Sprout Seal", material: "Bronze" },
  { level: 2, threshold: 10_000, name: "Guardian Shield", material: "Silver" },
  { level: 3, threshold: 100_000, name: "Hex Star", material: "Gold" },
  { level: 4, threshold: 1_000_000, name: "Faceted Crystal", material: "Platinum" },
  { level: 5, threshold: 10_000_000, name: "Laurel Crest", material: "Emerald" },
  { level: 6, threshold: 50_000_000, name: "Sovereign Crown", material: "Sapphire" },
  { level: 7, threshold: 100_000_000, name: "Solar Radiance", material: "Ruby" },
  { level: 8, threshold: 200_000_000, name: "Celestial Orbit", material: "Prismatic" },
] as const;

export function milestoneLevelFor(followers: number): number {
  let level = 0;
  for (const m of MILESTONES) if (followers >= m.threshold) level = m.level;
  return level;
}

export function nextMilestone(followers: number): MilestoneDef | null {
  return MILESTONES.find((m) => followers < m.threshold) ?? null;
}

export interface TopicDef {
  slug: string;
  label: string;
  keywords: string[];
}

/** Discovery topics. Used for interests, post topic inference, AI matching and Explore categories. */
export const TOPICS: readonly TopicDef[] = [
  { slug: "family", label: "Family & Home", keywords: ["family", "kids", "mom", "dad", "grandma", "grandpa", "home", "birthday", "holiday", "reunion", "parenting", "cousin", "sister", "brother", "wedding", "anniversary"] },
  { slug: "food", label: "Food & Cooking", keywords: ["food", "recipe", "cook", "cooking", "bake", "baking", "dinner", "lunch", "breakfast", "bread", "coffee", "tea", "grill", "bbq", "pie", "soup", "kitchen", "taco", "pizza"] },
  { slug: "sports", label: "Sports", keywords: ["game", "team", "score", "football", "soccer", "basketball", "baseball", "hockey", "golf", "tennis", "run", "running", "marathon", "playoffs", "season", "coach", "league"] },
  { slug: "photography", label: "Photography", keywords: ["photo", "photography", "camera", "lens", "shot", "light", "sunset", "sunrise", "portrait", "film", "exposure", "golden hour"] },
  { slug: "tech", label: "Technology", keywords: ["tech", "code", "coding", "software", "app", "computer", "ai", "phone", "gadget", "programming", "laptop", "robot", "internet", "keyboard"] },
  { slug: "gaming", label: "Gaming", keywords: ["gaming", "gamer", "game night", "console", "controller", "boss", "level", "speedrun", "board game", "puzzle", "chess", "arcade", "co-op"] },
  { slug: "music", label: "Music", keywords: ["music", "song", "album", "band", "concert", "guitar", "piano", "playlist", "singing", "drums", "vinyl", "choir", "lyrics"] },
  { slug: "outdoors", label: "Outdoors", keywords: ["hike", "hiking", "camping", "trail", "mountain", "lake", "fishing", "garden", "gardening", "nature", "bird", "birds", "forest", "beach", "kayak", "weather", "snow"] },
  { slug: "books", label: "Books & Writing", keywords: ["book", "books", "reading", "novel", "author", "library", "story", "poem", "poetry", "writing", "chapter"] },
  { slug: "art", label: "Art & Making", keywords: ["art", "painting", "drawing", "sketch", "craft", "knit", "knitting", "woodworking", "pottery", "design", "diy", "sewing", "quilt"] },
  { slug: "business", label: "Business & Work", keywords: ["business", "startup", "shop", "customers", "launch", "marketing", "sales", "small business", "entrepreneur", "work", "career", "job", "meeting"] },
  { slug: "science", label: "Science & Space", keywords: ["science", "space", "stars", "planet", "moon", "telescope", "physics", "biology", "chemistry", "experiment", "nasa", "rocket", "eclipse"] },
  { slug: "travel", label: "Travel", keywords: ["travel", "trip", "flight", "road trip", "vacation", "city", "museum", "train", "passport", "airport", "explore"] },
  { slug: "pets", label: "Pets & Animals", keywords: ["dog", "dogs", "cat", "cats", "puppy", "kitten", "pet", "pets", "horse", "chickens", "vet", "fish tank"] },
  { slug: "film", label: "Film & TV", keywords: ["movie", "movies", "film", "show", "series", "episode", "netflix", "cinema", "trailer", "documentary", "sitcom"] },
  { slug: "humor", label: "Humor", keywords: ["lol", "funny", "joke", "hilarious", "meme", "pun", "laugh"] },
] as const;

export const TOPIC_SLUGS = TOPICS.map((t) => t.slug);

export const BUSINESS_CATEGORIES = [
  "Retail", "Food & Drink", "Services", "Creative Studio", "Technology", "Health & Wellness",
  "Home & Garden", "Education", "Events", "Nonprofit", "Media", "Other",
] as const;

export const AFFILIATION_TYPES = [
  { value: "parent_company", label: "Parent company" },
  { value: "subsidiary", label: "Subsidiary" },
  { value: "partner", label: "Partner" },
  { value: "brand", label: "Brand" },
  { value: "creator_affiliate", label: "Creator affiliate" },
] as const;
export type AffiliationType = (typeof AFFILIATION_TYPES)[number]["value"];

export const REPORT_REASONS = ["spam", "harassment", "privacy", "impersonation", "inappropriate", "other"] as const;
