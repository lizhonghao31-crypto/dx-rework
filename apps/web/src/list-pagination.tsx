import { LIST_PAGE_SIZE } from "@dx-rework/contracts/reporting";
import { PageJump } from "@dx-rework/ui/production";
import { useEffect, useMemo, useState } from "react";

import { todoPageWindow } from "./todo-pagination.js";
import "./my-todos.css";

export { LIST_PAGE_SIZE } from "@dx-rework/contracts/reporting";

export const listPageWindow = todoPageWindow;

export function usePaginatedItems<T>(items: readonly T[], resetKey: string, pageSize = LIST_PAGE_SIZE) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.min(page, totalPages);

  useEffect(() => setPage(1), [resetKey]);
  useEffect(() => setPage((current) => Math.min(current, totalPages)), [totalPages]);

  const visibleItems = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return items.slice(start, start + pageSize);
  }, [currentPage, items, pageSize]);

  return { items: visibleItems, page: currentPage, totalPages, setPage } as const;
}

type PaginationItem =
  | Readonly<{
      kind: "page";
      page: number;
      active: boolean;
      disabled: boolean;
      onClick: () => void;
    }>
  | Readonly<{
      kind: "ellipsis";
      key: "start-ellipsis" | "end-ellipsis";
    }>;

function PaginationNav({ items, ariaLabel, page, totalPages, total, busy, pendingPage, onPageChange }: Readonly<{
  items: readonly PaginationItem[]; ariaLabel: string; page: number; totalPages: number | null;
  total?:number|null|undefined; busy: boolean; pendingPage?:number|undefined; onPageChange(page: number): void;
}>) {
  const previousPage = totalPages === null ? page - 1 : Math.min(page - 1, Math.max(1, totalPages));
  return (
    <nav className="my-todos-pagination" aria-label={ariaLabel}>
      {total!=null&&<span>共 {total} 条</span>}
      <button type="button" disabled={busy || totalPages === null || page <= 1 || pendingPage === previousPage} onClick={() => onPageChange(previousPage)}>上一页</button>
      {totalPages!==null&&items.map((item) => item.kind === "ellipsis"
        ? <span className="my-todos-pagination__ellipsis" aria-hidden="true" key={item.key}>…</span>
        : <button
            type="button"
            className={item.active ? "is-active" : ""}
            aria-current={item.active ? "page" : undefined}
            disabled={item.disabled}
            onClick={item.onClick}
            key={item.page}
          >{item.page}</button>)}
      <button type="button" disabled={busy || totalPages === null || page >= totalPages || pendingPage === page + 1} onClick={() => onPageChange(page + 1)}>下一页</button>
      <PageJump page={page} totalPages={totalPages} busy={busy} onPage={onPageChange} />
    </nav>
  );
}

type ListPaginationProps = Readonly<{
  page: number;
  totalPages: number | null;
  onPageChange: (page: number) => void;
  ariaLabel: string;
  busy?: boolean;
  total?: number | null;
  pendingPage?: number | undefined;
}>;

export function ListPagination({ page, totalPages, onPageChange, ariaLabel, total, pendingPage, busy = false }: ListPaginationProps) {
  const pageCount = Math.max(1, Math.floor(totalPages ?? 1));
  const currentPage = Math.max(1, Math.floor(page));
  const pages = listPageWindow(currentPage, pageCount);
  const firstPage = pages[0] ?? 1;
  const lastPage = pages.at(-1) ?? firstPage;
  const items: PaginationItem[] = [];

  if (firstPage > 1) {
    items.push({ kind: "page", page: 1, active: currentPage === 1, disabled: busy || pendingPage === 1, onClick: () => onPageChange(1) });
  }
  if (firstPage > 2) items.push({ kind: "ellipsis", key: "start-ellipsis" });
  for (const pageNumber of pages) {
    items.push({
      kind: "page",
      page: pageNumber,
      active: pageNumber === currentPage,
      disabled: busy || totalPages === null || pageNumber === currentPage || pendingPage === pageNumber,
      onClick: () => onPageChange(pageNumber),
    });
  }
  if (lastPage < pageCount - 1) items.push({ kind: "ellipsis", key: "end-ellipsis" });
  if (lastPage < pageCount) {
    items.push({ kind: "page", page: pageCount, active: currentPage === pageCount, disabled: busy || pendingPage === pageCount, onClick: () => onPageChange(pageCount) });
  }

  return <PaginationNav items={items} ariaLabel={ariaLabel} page={currentPage} totalPages={totalPages}
    total={total} busy={busy} pendingPage={pendingPage} onPageChange={onPageChange} />;
}
