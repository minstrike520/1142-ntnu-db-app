/**
 * Replacement for `@iconify/react` (see vitest.config.ts alias). The real
 * component fetches icon data over HTTP at runtime, which is nondeterministic
 * in jsdom; this stub renders a stable placeholder instead.
 */
import React from "react";

export function Icon({
  icon,
  ...rest
}: { icon: string } & React.SVGProps<SVGSVGElement>): React.ReactElement {
  return <svg data-icon={icon} {...rest} />;
}
