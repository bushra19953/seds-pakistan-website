"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export default function VerifyLandingClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [code, setCode] = useState("");

  // Support `?code=` deep link: redirect to /verify/<code>
  useEffect(() => {
    const qp = searchParams?.get("code");
    if (qp && qp.trim()) {
      router.replace(`/verify/${encodeURIComponent(qp.trim())}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const c = code.trim();
    if (!c) return;
    router.push(`/verify/${encodeURIComponent(c)}`);
  };

  return (
    <div className="container px-4 md:px-6 py-8">
      <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
        <CardHeader>
          <CardTitle className="font-heading text-2xl">Certificate Verification</CardTitle>
          <CardDescription className="font-body">Enter your certificate code to verify its authenticity.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Enter certificate code"
              className="w-full sm:w-80"
              aria-label="Certificate code"
            />
            <Button type="submit">Verify</Button>
          </form>
          <p className="mt-3 text-sm text-muted-foreground">Tip: You can also use a direct link like <span className="font-mono">/verify/&lt;code&gt;</span>.</p>
        </CardContent>
      </Card>
    </div>
  );
}

