import { useEffect, useMemo, useState } from "react";

import { todoPageWindow } from "./todo-pagination.js";
import "./my-todos.css";

export const LIST_PAGE_SIZE = 15;

export const listPageWindow = todoPageWindow;

export function cursorPageWindow(page: number, canGoPrevious: boolean, canGoNext: boolean): number[] {
  const currentPage = Math.max(1, Math.floor(page));
  return [
    ...(canGoPrevious && currentPage > 1 ? [currentPage - 1] : []),
    currentPage,
    ...(canGoNext ? [currentPage + 1] : []),
  ];
}

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

function PaginationNav({ items, ariaLabel }: Readonly<{ items: readonly PaginationItem[]; ariaLabel: string }>) {
  return (
    <nav className="my-todos-pagination" aria-label={ariaLabel}>
      {items.map((item) => item.kind === "ellipsis"
        ? <span className="my-todos-pagination__ellipsis" aria-hidden="true" key={item.key}>…</span>
        : <button
            type="button"
            className={item.active ? "is-active" : ""}
            aria-current={item.active ? "page" : undefined}
            disabled={item.disabled}
            onClick={item.onClick}
            key={item.page}
          >{item.page}</button>)}
    </nav>
  );
}

type ListPaginationProps = Readonly<{
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  ariaLabel: string;
}>;

export function ListPagination({ page, totalPages, onPageChange, ariaLabel }: ListPaginationProps) {
  const pageCount = Math.max(1, Math.floor(totalPages));
  const currentPage = Math.min(pageCount, Math.max(1, Math.floor(page)));
  const pages = listPageWindow(currentPage, pageCount);
  const firstPage = pages[0] ?? 1;
  const lastPage = pages.at(-1) ?? firstPage;
  const items: PaginationItem[] = [];

  if (firstPage > 1) {
    items.push({ kind: "page", page: 1, active: currentPage === 1, disabled: false, onClick: () => onPageChange(1) });
  }
  if (firstPage > 2) items.push({ kind: "ellipsis", key: "start-ellipsis" });
  for (const pageNumber of pages) {
    items.push({
      kind: "page",
      page: pageNumber,
      active: pageNumber === currentPage,
      disabled: false,
      onClick: () => onPageChange(pageNumber),
    });
  }
  if (lastPage < pageCount - 1) items.push({ kind: "ellipsis", key: "end-ellipsis" });
  if (lastPage < pageCount) {
    items.push({ kind: "page", page: pageCount, active: currentPage === pageCount, disabled: false, onClick: () => onPageChange(pageCount) });
  }

  return <PaginationNav items={items} ariaLabel={ariaLabel} />;
}

type CursorListPaginationProps = Readonly<{
  page: number;
  canGoPrevious: boolean;
  canGoNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  ariaLabel: string;
  busy?: boolean;
}>;

export function CursorListPagination({ page, canGoPrevious, canGoNext, onPrevious, onNext, ariaLabel, busy = false }: CursorListPaginationProps) {
  const currentPage = Math.max(1, Math.floor(page));
  const items: PaginationItem[] = cursorPageWindow(currentPage, canGoPrevious, canGoNext).map((pageNumber): PaginationItem => ({
    kind: "page",
    page: pageNumber,
    active: pageNumber === currentPage,
    disabled: busy,
    onClick: pageNumber < currentPage
      ? onPrevious
      : pageNumber > currentPage
        ? onNext
        : () => undefined,
  }));

  return <PaginationNav items={items} ariaLabel={ariaLabel} />;
}
