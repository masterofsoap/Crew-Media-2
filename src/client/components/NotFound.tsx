import { Link } from "react-router";
import { Button } from "./ui";

export function NotFound() {
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-24 text-center">
      <p className="heading text-6xl font-extrabold text-accent">404</p>
      <h1 className="text-2xl font-bold">This page wandered off</h1>
      <p className="max-w-sm text-muted">The link may be broken, or the page may have been removed or made private.</p>
      <Link to="/home">
        <Button>Go home</Button>
      </Link>
    </div>
  );
}
