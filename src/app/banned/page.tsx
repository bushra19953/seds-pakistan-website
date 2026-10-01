import { Ban } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Link from 'next/link';

export default function BannedPage() {
    return (
        <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-background text-foreground text-center">
            <div className="max-w-md space-y-6">
                <div className="mx-auto w-24 h-24 bg-red-100 rounded-full flex items-center justify-center mb-6">
                    <Ban className="w-12 h-12 text-red-600" />
                </div>
                <h1 className="text-3xl font-bold tracking-tight">Account Suspended</h1>
                <p className="text-muted-foreground">
                    Your account has been suspended due to repeated violations of our policies (e.g., missed deadlines).
                    Access to this platform is restricted.
                </p>
                <div className="p-4 bg-muted/50 rounded-lg border border-border text-sm">
                    <strong>Review Process:</strong> Suspensions are typically permanent unless successfully appealed.
                    Contact your chapter lead or the administration if you believe this is an error.
                </div>
                <div className="pt-4">
                    <Link href="/auth/login">
                        <Button variant="outline">Return to Login</Button>
                    </Link>
                </div>
            </div>
        </div>
    );
}
