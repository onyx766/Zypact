import Image from "next/image";

type ZypactLogoProps = {
  href?: string;
  priority?: boolean;
  className?: string;
};

export function ZypactLogo({
  href = "/",
  priority = false,
  className = "",
}: ZypactLogoProps) {
  return (
    <a
      href={href}
      className={`zypact-logo-link ${className}`.trim()}
      aria-label="Zypact home"
    >
      <Image
        src="/zypact-logo.svg"
        alt="Zypact"
        width={1536}
        height={1024}
        priority={priority}
        className="zypact-logo-image"
      />
    </a>
  );
}
