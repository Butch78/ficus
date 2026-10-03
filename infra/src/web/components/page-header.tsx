import { Breadcrumbs, Text } from "@cloudflare/kumo";
import { Fragment, type ReactNode } from "react";
import { BreadcrumbsCurrent, BreadcrumbsLink, BreadcrumbsSeparator } from "./kumo.ts";

interface Props {
  /** The trail above this page: label and target, outermost first. */
  readonly trail: ReadonlyArray<readonly [string, string]>;
  readonly title: ReactNode;
  readonly children?: ReactNode;
}

/** Breadcrumbs, then the page's title, then whatever sits beside it. */
export function PageHeader({ trail, title, children }: Props) {
  return (
    <div className="flex flex-col gap-2">
      <Breadcrumbs size="sm">
        {trail.map(([label, href]) => (
          <Fragment key={href}>
            <BreadcrumbsLink href={href}>{label}</BreadcrumbsLink>
            <BreadcrumbsSeparator />
          </Fragment>
        ))}
        <BreadcrumbsCurrent>{title}</BreadcrumbsCurrent>
      </Breadcrumbs>
      <div className="flex flex-wrap items-center gap-3">
        <Text variant="heading" as="h2" size="lg">
          {title}
        </Text>
        {children}
      </div>
    </div>
  );
}
