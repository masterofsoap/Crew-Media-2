import { StrictMode, Suspense, lazy, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation, useRouteError, isRouteErrorResponse } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@fontsource/inter/400.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/800.css";
import "@fontsource/playfair-display";
import "@fontsource/space-grotesk";
import "@fontsource/press-start-2p";
import "@fontsource/cormorant-garamond";
import "@fontsource/orbitron";
import "@fontsource/fraunces";
import "@fontsource/jetbrains-mono";
import "@fontsource/poiret-one";
import "@fontsource/cinzel";
import "@fontsource/quicksand";
import "@fontsource/libre-baskerville";
import "@fontsource/syne";
import "./styles.css";
import { SessionProvider, useSession } from "./lib/session";
import { RealtimeProvider } from "./lib/realtime";
import { applyTheme } from "./lib/theme";
import { ToastProvider } from "./components/toast";
import { AppLayout, Centered } from "./components/Layout";
import { ApiError } from "./lib/api";
import { Button, Spinner } from "./components/ui";
import { SignIn, SignUp, Recover } from "./pages/Auth";
import { Home } from "./pages/Home";
import { NotFound } from "./components/NotFound";

applyTheme(null);

const lazyPage = <T extends Record<string, unknown>>(load: () => Promise<T>, name: keyof T) =>
  lazy(async () => ({ default: (await load())[name] as React.ComponentType }));

const Onboarding = lazyPage(() => import("./pages/Onboarding"), "Onboarding");
const Explore = lazyPage(() => import("./pages/Explore"), "Explore");
const SearchPage = lazyPage(() => import("./pages/Explore"), "SearchPage");
const HashtagPage = lazyPage(() => import("./pages/Explore"), "HashtagPage");
const TopicPage = lazyPage(() => import("./pages/Explore"), "TopicPage");
const PostThread = lazyPage(() => import("./pages/PostThread"), "PostThread");
const PostHistory = lazyPage(() => import("./pages/PostThread"), "PostHistory");
const ProfilePage = lazyPage(() => import("./pages/Profile"), "ProfilePage");
const FollowList = lazyPage(() => import("./pages/Profile"), "FollowList");
const MilestonesPage = lazyPage(() => import("./pages/Profile"), "MilestonesPage");
const Notifications = lazyPage(() => import("./pages/Notifications"), "Notifications");
const Inbox = lazyPage(() => import("./pages/Messages"), "Inbox");
const Conversation = lazyPage(() => import("./pages/Messages"), "Conversation");
const Studio = lazyPage(() => import("./pages/Studio"), "Studio");
const ThemesPage = lazyPage(() => import("./pages/Themes"), "ThemesPage");
const Settings = lazyPage(() => import("./pages/Settings"), "Settings");
const AiPrefs = lazyPage(() => import("./pages/Settings"), "AiPrefs");
const NewProfile = lazyPage(() => import("./pages/Settings"), "NewProfile");
const BusinessNew = lazyPage(() => import("./pages/Business"), "BusinessNew");
const BusinessDashboard = lazyPage(() => import("./pages/Business"), "BusinessDashboard");
const Affiliates = lazyPage(() => import("./pages/Business"), "Affiliates");
const AdminShell = lazyPage(() => import("./pages/admin/Admin"), "AdminShell");
const AdminDashboard = lazyPage(() => import("./pages/admin/Admin"), "AdminDashboard");
const AdminAccounts = lazyPage(() => import("./pages/admin/Admin"), "AdminAccounts");
const AdminAccountDetail = lazyPage(() => import("./pages/admin/Admin"), "AdminAccountDetail");
const AdminAdmins = lazyPage(() => import("./pages/admin/Admin"), "AdminAdmins");
const AdminAi = lazyPage(() => import("./pages/admin/AdminOps"), "AdminAi");
const AdminMedia = lazyPage(() => import("./pages/admin/AdminOps"), "AdminMedia");
const AdminReports = lazyPage(() => import("./pages/admin/AdminOps"), "AdminReports");
const AdminLogs = lazyPage(() => import("./pages/admin/AdminOps"), "AdminLogs");

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (n, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && n < 2,
      staleTime: 15_000,
      refetchOnWindowFocus: false,
    },
  },
});

function Loading() {
  return (
    <div className="flex justify-center py-16">
      <Spinner size={28} label="Loading" />
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading } = useSession();
  const loc = useLocation();
  if (loading)
    return (
      <Centered>
        <Spinner size={32} label="Loading Crew Plus" />
      </Centered>
    );
  if (!session) return <Navigate to={`/?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <RealtimeProvider>{children}</RealtimeProvider>;
}

function GuestOnly({ children }: { children: ReactNode }) {
  const { session, loading } = useSession();
  if (loading) return null;
  if (session) return <Navigate to="/home" replace />;
  return <>{children}</>;
}

/** Old /signin links (and their ?next=) land on the sign-in homepage. */
function ToRoot() {
  const loc = useLocation();
  return <Navigate to={`/${loc.search}`} replace />;
}

function Suspended() {
  return (
    <Suspense fallback={<Loading />}>
      <Outlet />
    </Suspense>
  );
}

function RouteError() {
  const err = useRouteError();
  if (isRouteErrorResponse(err) && err.status === 404) return <NotFound />;
  return (
    <Centered>
      <div className="card max-w-md space-y-4 p-6 text-center" role="alert">
        <h1 className="text-xl font-bold">Something went wrong</h1>
        <p className="text-sm text-muted">{err instanceof Error ? err.message : "An unexpected error occurred."}</p>
        <Button onClick={() => location.reload()}>Reload</Button>
      </div>
    </Centered>
  );
}

const router = createBrowserRouter([
  {
    errorElement: <RouteError />,
    element: <Suspended />,
    children: [
      { path: "/", element: <GuestOnly><SignIn /></GuestOnly> },
      { path: "/signin", element: <ToRoot /> },
      { path: "/signup", element: <GuestOnly><SignUp /></GuestOnly> },
      { path: "/recover", element: <Recover /> },
      { path: "/onboarding", element: <RequireAuth><Onboarding /></RequireAuth> },
      {
        element: <RequireAuth><AppLayout /></RequireAuth>,
        children: [
          {
            element: <Suspended />,
            children: [
              { path: "/home", element: <Home /> },
              { path: "/explore", element: <Explore /> },
              { path: "/search", element: <SearchPage /> },
              { path: "/hashtag/:tag", element: <HashtagPage /> },
              { path: "/topic/:slug", element: <TopicPage /> },
              { path: "/post/:id", element: <PostThread /> },
              { path: "/post/:id/history", element: <PostHistory /> },
              { path: "/notifications", element: <Notifications /> },
              { path: "/messages", element: <Inbox /> },
              { path: "/messages/:id", element: <Conversation /> },
              { path: "/themes", element: <ThemesPage /> },
              { path: "/settings", element: <Settings /> },
              { path: "/settings/ai", element: <AiPrefs /> },
              { path: "/profiles/new", element: <NewProfile /> },
              { path: "/business/new", element: <BusinessNew /> },
              { path: "/business", element: <BusinessDashboard /> },
              { path: "/business/affiliates", element: <Affiliates /> },
              { path: "/:handle", element: <ProfilePage /> },
              { path: "/:handle/:list", element: <FollowList /> },
              { path: "/:handle/milestones", element: <MilestonesPage /> },
              { path: "*", element: <NotFound /> },
            ],
          },
        ],
      },
      {
        element: <RequireAuth><AppLayout wide /></RequireAuth>,
        children: [
          {
            element: <Suspended />,
            children: [
              { path: "/studio", element: <Studio /> },
              {
                path: "/admin",
                element: <AdminShell />,
                children: [
                  { index: true, element: <AdminDashboard /> },
                  { path: "accounts", element: <AdminAccounts /> },
                  { path: "accounts/:id", element: <AdminAccountDetail /> },
                  { path: "admins", element: <AdminAdmins /> },
                  { path: "ai", element: <AdminAi /> },
                  { path: "media", element: <AdminMedia /> },
                  { path: "reports", element: <AdminReports /> },
                  { path: "logs", element: <AdminLogs /> },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <ToastProvider>
          <div className="app-backdrop" aria-hidden="true" />
          <RouterProvider router={router} />
        </ToastProvider>
      </SessionProvider>
    </QueryClientProvider>
  </StrictMode>,
);
