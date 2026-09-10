"use client";

import { useState } from "react";
import { Menu, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ZypactWordmark } from "@/components/marketing/zypact-mark";

const navLinks = [
  { label: "How it works", href: "#how-it-works" },
  { label: "What you get", href: "#features" },
  { label: "Evidence", href: "#evidence" },
  { label: "Scope", href: "#scope" },
  { label: "FAQ", href: "#faq" },
] as const;

/**
 * Client component only because of the mobile disclosure. Below `md` the nav
 * links are collapsed behind a toggle rather than hidden outright, so mobile
 * visitors keep a route to every section.
 */
export function SiteHeader() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-transparent bg-surface-subtle/85 backdrop-blur-md">
      <div className="shell flex h-[68px] items-center justify-between gap-8">
        <div className="flex items-center gap-10">
          <ZypactWordmark className="text-primary" dotFill="#FAFBFA" />
          <nav aria-label="Primary" className="hidden items-center gap-8 md:flex">
            {navLinks.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                {link.label}
              </a>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-2.5">
          <Button asChild variant="outline" className="hidden sm:inline-flex">
            <a href="/login">Sign in</a>
          </Button>
          <Button asChild>
            <a href="/scan">Request demo</a>
          </Button>
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-controls="marketing-mobile-menu"
            aria-label={open ? "Close menu" : "Open menu"}
            className="inline-flex h-10 w-10 items-center justify-center rounded-[10px] border border-border text-foreground md:hidden"
          >
            {open ? (
              <X className="h-4 w-4" strokeWidth={2} />
            ) : (
              <Menu className="h-4 w-4" strokeWidth={2} />
            )}
          </button>
        </div>
      </div>

      <div
        id="marketing-mobile-menu"
        hidden={!open}
        className="border-t border-border bg-background md:hidden"
      >
        <nav aria-label="Primary (mobile)" className="shell flex flex-col py-2">
          {navLinks.map((link) => (
            <a
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className="border-b border-border py-3.5 text-[15px] font-medium text-foreground last:border-b-0"
            >
              {link.label}
            </a>
          ))}
          <a
            href="/login"
            onClick={() => setOpen(false)}
            className="py-3.5 text-[15px] font-medium text-muted-foreground sm:hidden"
          >
            Sign in
          </a>
        </nav>
      </div>
    </header>
  );
}
