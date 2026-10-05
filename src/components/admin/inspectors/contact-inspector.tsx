import React from "react";
import GenericInspector from "./generic-inspector";
import { z } from "zod";

const contactSchema = z.object({
    name: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    message: z.string().optional(),
    createdAt: z.any().optional(),
    meta: z.any().optional(),
}).passthrough();

export default function ContactInspector(props: any) {
    return (
        <GenericInspector
            {...props}
            title="CONTACT MESSAGE"
            schema={contactSchema}
            renderPayload={(data) => {
                const name = data?.name || "Unknown";
                const email = data?.email || "—";
                const phone = data?.phone || "not provided";
                const message = data?.message || "";
                return (
                    <div className="space-y-4">
                        <div className="bg-muted/40 p-4 rounded-lg">
                            <p className="text-xs text-muted-foreground uppercase tracking-widest font-semibold mb-1">From</p>
                            <p className="text-lg font-medium text-foreground">{name}</p>
                            <p className="text-sm text-muted-foreground mt-1">
                                <a href={`mailto:${email}`} className="text-blue-500 hover:underline">{email}</a>
                                {data?.phone ? (
                                    <> · <a href={`tel:${phone}`} className="text-blue-500 hover:underline">{phone}</a></>
                                ) : (
                                    <> · <span className="italic">no phone provided</span></>
                                )}
                            </p>
                        </div>
                        <div>
                            <p className="text-[10px] text-muted-foreground uppercase font-black tracking-[0.2em] mb-2">Message</p>
                            <div className="border border-border/50 p-4 rounded-xl bg-card text-sm text-foreground leading-relaxed whitespace-pre-wrap">
                                {message || <span className="italic text-muted-foreground">Empty message.</span>}
                            </div>
                        </div>
                    </div>
                );
            }}
        />
    );
}
