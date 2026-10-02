"use client";

export default function Failed({ error }: { readonly error: Error }) {
  return (
    <div className="card">
      <p className="error">{error.message}</p>
      <a href="/">Back to your organizations</a>
    </div>
  );
}
