import { Button } from "@/components/ui/button";
import { ZypactWordmark } from "@/components/v2/zypact-mark";

const navLinks = [
  { label: "How it works", href: "#how-it-works" },
  { label: "What you get", href: "#features" },
  { label: "Evidence", href: "#evidence" },
  { label: "Scope", href: "#scope" },
] as const;

export function SiteHeader() {
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
        </div>
      </div>
    </header>
  );
}
