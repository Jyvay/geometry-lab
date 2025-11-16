import React from "react";

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "secondary" };
export function Button({ variant = "default", className = "", ...props }: Props) {
  const base = "px-3 py-2 rounded-2xl text-sm transition border";
  const styles =
    variant === "secondary"
      ? "bg-slate-800 text-slate-100 border-slate-700 hover:bg-slate-700"
      : "bg-sky-600 text-white border-sky-500 hover:bg-sky-500";
  return <button className={`${base} ${styles} ${className}`} {...props} />;
}
