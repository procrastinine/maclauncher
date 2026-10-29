import React from "react";

function childText(children: React.ReactNode): string {
  return React.Children.toArray(children).map(child => React.isValidElement<{ children?: React.ReactNode }>(child)
    ? childText(child.props.children) : typeof child === "string" || typeof child === "number" ? String(child) : "").join("");
}

// Native menus retain their full option text. The closed control also exposes
// that text and its exact saved value when the available width is smaller.
export function Select({ title, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const value = props.value ?? props.defaultValue;
  let selected: React.ReactElement<{ value?: unknown; title?: string; children?: React.ReactNode }> | undefined;
  function find(options: React.ReactNode) {
    React.Children.forEach(options, option => {
      if (!React.isValidElement<{ value?: unknown; title?: string; children?: React.ReactNode }>(option)) return;
      if (option.type === "option" && (value == null ? !selected : String(option.props.value ?? childText(option.props.children)) === String(value))) selected = option;
      else if (option.type !== "option") find(option.props.children);
    });
  }
  if (!title && !props.multiple) find(children);
  const label = selected ? childText(selected.props.children) : "";
  const exact = selected?.props.title || selected?.props.value;
  const fallback = label && exact && String(exact) !== label ? `${label} (${exact})` : label;
  return <select {...props} title={title || fallback || undefined}>{children}</select>;
}
