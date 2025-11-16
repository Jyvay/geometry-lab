import React from "react";

export function Card({ className = "", children }: React.PropsWithChildren<{ className?: string }>) {
  return <div className={`rounded-2xl border border-slate-700 bg-slate-900/60 ${className}`}>{children}</div>;
}

export function CardContent({ className = "", children }: React.PropsWithChildren<{ className?: string }>) {
  return <div className={`p-4 ${className}`}>{children}</div>;
}