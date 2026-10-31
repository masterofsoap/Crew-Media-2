/** API data transfer types shared by the Worker and the client. */

export type ProfileKind = "personal" | "business" | "ai";

export interface ProfileSummary {
  id: string;
  handle: string;
  displayName: string;
  kind: ProfileKind;
  aiClass: "persona" | "audience" | null;
  avatarUrl: string | null;
  avatarSeed: string;
  milestoneLevel: number;
  isPrivate: boolean;
  themeId: string;
}

export interface ViewerRelationship {
  following: boolean;
  followedBy: boolean;
  requested: boolean;
  blocking: boolean;
  blockedBy: boolean;
  muting: boolean;
  canMessage: boolean;
}

export interface BusinessInfo {
  category: string;
  website: string;
}

export interface AffiliationView {
  id: string;
  relationType: string;
  status: "pending" | "accepted" | "declined" | "removed";
  business: ProfileSummary;
  affiliate: ProfileSummary;
  requestedBy: string;
  createdAt: number;
}

export interface MilestoneView {
  level: number;
  threshold: number;
  name: string;
  material: string;
  achievedAt: number | null;
}

export interface ProfileDetail extends ProfileSummary {
  bio: string;
  location: string;
  website: string;
  bannerUrl: string | null;
  appearance: unknown;
  followerCount: number;
  followingCount: number;
  postCount: number;
  createdAt: number;
  pinnedPostId: string | null;
  likesPublic: boolean;
  interests: string[];
  business: BusinessInfo | null;
  affiliations: AffiliationView[];
  milestones: MilestoneView[];
  relationship: ViewerRelationship | null;
  isSelf: boolean;
  canView: boolean; // false for private profiles the viewer doesn't follow
  aiPersona: { archetype: string; summary: string } | null;
}

export interface MediaView {
  id: string;
  kind: "image" | "video";
  url: string | null; // null once expired/removed
  thumbUrl: string | null;
  width: number | null;
  height: number | null;
  alt: string;
  status: "ready" | "expired" | "removed";
  expiresAt: number | null;
}

export interface PostView {
  id: string;
  author: ProfileSummary;
  text: string;
  createdAt: number;
  editedAt: number | null;
  replyToId: string | null;
  replyToHandle: string | null;
  rootId: string;
  aiGenerated: boolean;
  media: MediaView[];
  quote: PostView | null;
  likeCount: number;
  replyCount: number;
  repostCount: number;
  quoteCount: number;
  liked: boolean;
  reposted: boolean;
  deleted: boolean;
  moderation: "ok" | "flagged" | "removed";
}

export interface FeedItem {
  key: string;
  post: PostView;
  repostedBy: ProfileSummary | null;
  reason?: string;
}

export interface Page<T> {
  items: T[];
  cursor: string | null;
}

export interface NotificationView {
  id: string;
  type: string;
  actor: ProfileSummary | null;
  actorCount: number;
  post: { id: string; text: string } | null;
  data: Record<string, unknown>;
  read: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationView {
  id: string;
  kind: "direct" | "group";
  title: string | null;
  members: ProfileSummary[];
  lastMessage: { text: string | null; senderId: string; createdAt: number; deleted: boolean; hasMedia: boolean } | null;
  unread: number;
  lastMessageAt: number;
  muted: boolean;
}

export interface MessageView {
  id: string;
  conversationId: string;
  sender: ProfileSummary;
  text: string | null;
  media: MediaView[];
  createdAt: number;
  deleted: boolean;
  aiGenerated: boolean;
}

export interface OwnedProfile extends ProfileSummary {
  role: "owner" | "manager";
  unreadNotifications: number;
  unreadMessages: number;
}

export interface SessionInfo {
  identityId: string;
  activeProfileId: string;
  profiles: OwnedProfile[];
  admin: { role: "owner" | "admin" | "moderator"; elevated: boolean; hasPassphrase: boolean } | null;
  turnstileSiteKey: string | null;
}

export interface TrendView {
  tag: string;
  postCount: number;
  authorCount: number;
  score: number;
  relevant?: boolean;
}

export interface ApiError {
  error: string;
  code: string;
  fields?: Record<string, string>;
}

export interface RealtimeEvent {
  type: "message" | "message_deleted" | "typing" | "notification" | "read";
  conversationId?: string;
  profileId?: string;
  payload?: unknown;
}
