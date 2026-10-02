"use client";

/**
 * Kumo's compound parts as named exports, for server components.
 *
 * `@cloudflare/kumo` is a client module, so a server component holds each of
 * its exports as a client reference: it can render `Table`, but `Table.Row`
 * is a property of the reference, not an export, and comes out undefined.
 * Re-exported by name here, each part is its own reference.
 */
import { Breadcrumbs, Collapsible, LayerCard, Table } from "@cloudflare/kumo";

export const TableHeader = Table.Header;

export const TableHead = Table.Head;

export const TableBody = Table.Body;

export const TableRow = Table.Row;

export const TableCell = Table.Cell;

export const LayerCardPrimary = LayerCard.Primary;

export const LayerCardSecondary = LayerCard.Secondary;

export const BreadcrumbsLink = Breadcrumbs.Link;

export const BreadcrumbsSeparator = Breadcrumbs.Separator;

export const BreadcrumbsCurrent = Breadcrumbs.Current;

export const CollapsibleRoot = Collapsible.Root;

export const CollapsibleTrigger = Collapsible.DefaultTrigger;

export const CollapsiblePanel = Collapsible.DefaultPanel;
