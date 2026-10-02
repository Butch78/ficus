import { Empty, Link } from "@cloudflare/kumo";

export default function NotFound() {
  return (
    <Empty
      title="Nothing here"
      description="It does not exist, or it belongs to an organization you are not in."
      contents={<Link href="/">Back to your organizations</Link>}
    />
  );
}
