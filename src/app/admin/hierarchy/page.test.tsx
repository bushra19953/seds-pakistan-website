/**
 * Render tests for AdminHierarchyPage (Issues 2, 3, 7 plumbing).
 * Children are mocked: this suite pins the page-level contract only:
 * default chapter "all" on mount, the empty-state fallback for a genuinely
 * empty selection, and focusRequest plumbing from overview to canvas.
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

jest.mock("@/components/admin/AuthorizationGate", () => ({
    __esModule: true,
    default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock("@/components/admin/hierarchy/chapter-selector", () => ({
    __esModule: true,
    ChapterSelector: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
        <div data-testid="chapter-selector" data-value={value}>
            <button onClick={() => onChange("")}>clear-chapter</button>
        </div>
    ),
}));

jest.mock("@/components/admin/hierarchy/role-clusters-overview", () => ({
    __esModule: true,
    default: ({ onFocusPerson }: { onFocusPerson: (uid: string) => void }) => (
        <button data-testid="overview-focus" onClick={() => onFocusPerson("uid-42")}>
            focus-person
        </button>
    ),
}));

jest.mock("next/dynamic", () => () => {
    const MockCanvas = (props: {
        chapterId: string;
        focusRequest: { uid: string; nonce: number } | null;
    }) => (
        <div
            data-testid="hierarchy-canvas"
            data-chapter={props.chapterId}
            data-focus-uid={props.focusRequest ? props.focusRequest.uid : ""}
            data-focus-nonce={props.focusRequest ? String(props.focusRequest.nonce) : ""}
        />
    );
    return MockCanvas;
});

import AdminHierarchyPage from "./page";

// The component tree uses the classic JSX runtime under jest, so React must
// be in global scope at render time (same pattern as gallery-section.test.tsx).
(global as any).React = React;

describe("AdminHierarchyPage", () => {
    it("mounts with the org-wide chapter selected so the canvas renders immediately (Issue 3)", () => {
        render(<AdminHierarchyPage />);
        expect(screen.getByTestId("chapter-selector")).toHaveAttribute("data-value", "all");
        expect(screen.getByTestId("hierarchy-canvas")).toHaveAttribute("data-chapter", "all");
        expect(screen.queryByText("No Chapter Selected")).not.toBeInTheDocument();
    });

    it("keeps the empty-state fallback for a genuinely empty selection (Issue 2)", () => {
        render(<AdminHierarchyPage />);
        fireEvent.click(screen.getByText("clear-chapter"));
        expect(screen.queryByTestId("hierarchy-canvas")).not.toBeInTheDocument();
        expect(screen.getByText("No Chapter Selected")).toBeInTheDocument();
    });

    it("plumbs a focus request from the overview to the canvas (Issue 7)", () => {
        render(<AdminHierarchyPage />);
        const canvas = screen.getByTestId("hierarchy-canvas");
        expect(canvas).toHaveAttribute("data-focus-uid", "");
        fireEvent.click(screen.getByTestId("overview-focus"));
        expect(canvas).toHaveAttribute("data-focus-uid", "uid-42");
        expect(canvas.getAttribute("data-focus-nonce")).not.toBe("");
        // A second click issues a fresh nonce so the canvas effect re-fires.
        const firstNonce = canvas.getAttribute("data-focus-nonce");
        fireEvent.click(screen.getByTestId("overview-focus"));
        expect(canvas.getAttribute("data-focus-nonce")).not.toBe(firstNonce);
    });
});
