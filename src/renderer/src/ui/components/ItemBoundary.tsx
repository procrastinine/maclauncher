import React from "react";
import {ErrorText} from "./ErrorText";

type ItemProps = {label: string; as?: "li" | "div"; reset?: unknown; action?: React.ReactNode};

function ItemFailure({label, as: Tag = "div", error, action}: ItemProps & {error: unknown}) {
  return <Tag className="detailRow itemFailure">
    <ErrorText inline error={`${label} could not be displayed. ${error instanceof Error ? error.message : String(error)}`} />
    {action}
  </Tag>;
}

// One list item that fails to render is replaced by its reason; the other items
// keep rendering. A changed `reset` value renders the item again.
class ItemBoundary extends React.Component<ItemProps & {children?: React.ReactNode}, {error?: unknown; reset?: unknown}> {
  state: {error?: unknown; reset?: unknown} = {reset: this.props.reset};
  static getDerivedStateFromError(error: unknown) { return {error}; }
  static getDerivedStateFromProps(props: ItemProps, state: {error?: unknown; reset?: unknown}) {
    return Object.is(props.reset, state.reset) ? null : {error: undefined, reset: props.reset};
  }
  render() { return this.state.error === undefined ? this.props.children : <ItemFailure {...this.props} error={this.state.error} />; }
}

/** Renders one item of a list in isolation: an exception while building or rendering it affects only that item. */
export function isolatedItem(key: React.Key, props: ItemProps, render: () => React.ReactNode) {
  try { return <ItemBoundary key={key} {...props}>{render()}</ItemBoundary>; }
  catch (error) { return <ItemFailure key={key} {...props} error={error} />; }
}
