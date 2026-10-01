import { useState, ReactNode } from 'react';
import { useUser } from '@/firebase';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import GoogleOnlyAuthForm from '@/components/auth/google-only-auth-form';
import { Button, ButtonProps } from '@/components/ui/button';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

interface AuthGuardedButtonProps extends ButtonProps {
    children: ReactNode;
    onAuthenticatedClick: () => void;
    redirectPath?: string;
}

export function AuthGuardedButton({
    children,
    onAuthenticatedClick,
    redirectPath,
    ...buttonProps
}: AuthGuardedButtonProps) {
    const { user, isLoading } = useUser();
    const [isModalOpen, setIsModalOpen] = useState(false);
    const router = useRouter();

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.preventDefault();
        if (isLoading) return;

        if (!user) {
            if (redirectPath) {
                // If we want the auth form to redirect somewhere specific after login
                const currentUrl = new URL(window.location.href);
                currentUrl.searchParams.set('callbackUrl', redirectPath);
                window.history.replaceState({}, '', currentUrl.toString());
            }
            setIsModalOpen(true);
        } else {
            onAuthenticatedClick();
        }
    };

    return (
        <>
            <Button onClick={handleClick} disabled={buttonProps.disabled || isLoading} {...buttonProps}>
                {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {children}
            </Button>

            <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
                <DialogContent
                    className="sm:max-w-md bg-transparent border-none shadow-none p-0 overflow-visible"
                    onInteractOutside={(e) => e.preventDefault()}
                >
                    <GoogleOnlyAuthForm />
                </DialogContent>
            </Dialog>
        </>
    );
}
