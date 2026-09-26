"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronsUpDown, Loader2 } from "lucide-react";

import { switchDemoUser } from "@/lib/actions";
import { DEFAULT_DEMO_USER_ID } from "@/lib/demo-users";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

/** The exact five personas `scripts/seed.mjs` writes. Real sign-in is out of
 * scope for the reference dashboard, so this list is the session source. */
const DEMO_USERS = [
  { id: DEFAULT_DEMO_USER_ID, name: "Owner (you)", role: "owner" },
  { id: "c0000000-0000-0000-0000-000000000002", name: "Amira Rahman", role: "agent" },
  { id: "c0000000-0000-0000-0000-000000000003", name: "Farid Hassan", role: "agent" },
  { id: "c0000000-0000-0000-0000-000000000004", name: "Siti Aminah", role: "agent" },
  { id: "c0000000-0000-0000-0000-000000000005", name: "Wei Chen", role: "agent" },
] as const;

function initialsOf(name: string) {
  return name
    .replace(/\(.*?\)/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function UserSwitcher({
  currentMember,
  demoMode,
}: {
  currentMember: { userId: string; role: string } | null;
  demoMode: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [optimisticUserId, setOptimisticUserId] = useState<string | null>(null);

  const activeUserId = optimisticUserId ?? currentMember?.userId ?? null;
  const activeUser = DEMO_USERS.find((user) => user.id === activeUserId) ?? null;
  const activeName = activeUser?.name ?? (currentMember ? "Signed in" : "Not signed in");
  const activeRole = activeUser?.role ?? currentMember?.role ?? "no session";

  function handleSelect(userId: string) {
    if (userId === activeUserId) return;
    setOptimisticUserId(userId);
    startTransition(async () => {
      await switchDemoUser(userId);
      // The action's revalidatePath handles the server data; refreshing here
      // keeps the sidebar in sync no matter which route we're standing on.
      router.refresh();
      setOptimisticUserId(null);
    });
  }

  if (!currentMember) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            Not signed in
          </div>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  if (!demoMode) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            Signed in as <span className="font-medium text-foreground">{activeName}</span>
          </div>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <SidebarMenuButton
                  size="lg"
                  className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                />
              }
            >
              <Avatar className="size-8 rounded-md">
                <AvatarFallback className="rounded-md bg-muted text-xs font-medium">
                  {initialsOf(activeName) || "?"}
                </AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate text-sm font-medium">{activeName}</span>
                <span className="truncate text-xs capitalize text-muted-foreground">
                  {activeRole}
                </span>
              </div>
              {isPending ? (
                <Loader2 className="size-4 animate-spin opacity-60" />
              ) : (
                <ChevronsUpDown className="size-4 opacity-60" />
              )}
            </DropdownMenuTrigger>

            <DropdownMenuContent
              className="w-64"
              side="top"
              align="start"
              sideOffset={8}
            >
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  View dashboard as
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {DEMO_USERS.map((user) => (
                  <DropdownMenuItem
                    key={user.id}
                    onClick={() => handleSelect(user.id)}
                    className="gap-3"
                  >
                    <Avatar className="size-6 rounded-md">
                      <AvatarFallback className="rounded-md text-[10px] font-medium">
                        {initialsOf(user.name)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="grid flex-1 leading-tight">
                      <span className="truncate text-sm">{user.name}</span>
                      <span className="truncate text-xs capitalize text-muted-foreground">
                        {user.role}
                      </span>
                    </div>
                    {user.id === activeUserId ? (
                      <Check className="size-4 text-primary" />
                    ) : (
                      <span className="size-4" />
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

      <p className="px-2 text-[11px] leading-relaxed text-muted-foreground">
        Demo identity switcher, stands in for real sign-in. Every query runs as
        the selected member.
      </p>
    </div>
  );
}
