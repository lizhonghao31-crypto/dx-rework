import { useEffect, useMemo, useState } from "react";

import { todoPageWindow } from "./todo-pagination.js";
import "./list-pagination.css";

export const LIST_PAGE_SIZE = 15;

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
  return (
    <nav className="list-pagination" aria-label={ariaLabel}>
      {pages[0] !== 1 && <><button type="button" onClick={() => onPageChange(1)}>1</button><span>…</span></>}
      {pages.map((item) => (
        <button
          type="button"
          className={item === currentPage ? "is-active" : undefined}
          aria-current={item === currentPage ? "page" : undefined}
          onClick={() => onPageChange(item)}
          key={item}
        >{item}</button>
      ))}
      {pages[pages.length - 1] !== pageCount && <><span>…</span><button type="button" onClick={() => onPageChange(pageCount)}>{pageCount}</button></>}
    </nav>
  );
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
  return (
    <nav className="list-pagination" aria-label={ariaLabel}>
      <button type="button" aria-label="上一页" disabled={busy || !canGoPrevious} onClick={onPrevious}>‹</button>
      <button type="button" className="is-active" aria-current="page" disabled>{page}</button>
      <button type="button" aria-label="下一页" disabled={busy || !canGoNext} onClick={onNext}>›</button>
    </nav>
  );
}
