import React from "react";

type LauncherViewHeaderProps = {
  title: string;
  titleId: string;
  children?: React.ReactNode;
};

export function LauncherViewHeader({ title, titleId, children }: LauncherViewHeaderProps) {
  return <header className="launcherViewHeader">
    <h1 className="launcherViewTitle" id={titleId}>{title}</h1>
    <div className="launcherViewActions">{children}</div>
  </header>;
}
