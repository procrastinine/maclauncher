import React from "react";

type LauncherViewHeaderProps = {
  title: string;
  titleId: string;
  children?: React.ReactNode;
};

// Each view is its own native window, and the window title names it. The
// heading stays for assistive technology only; a view without actions has no
// header bar.
export function LauncherViewHeader({ title, titleId, children }: LauncherViewHeaderProps) {
  const heading = <h1 className="launcherViewTitle visuallyHidden" id={titleId}>{title}</h1>;
  if (!children) return heading;
  return <header className="launcherViewHeader">
    {heading}
    <div className="launcherViewActions">{children}</div>
  </header>;
}
