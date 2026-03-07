"use client"

import * as React from "react"
import {
  IconBuilding,
  IconCalendar,
  IconBuildingChurch,
  IconHeart,
  IconHelp,
  IconLayoutDashboard,
  IconSettings,
  IconUsers,
  IconUsersGroup,
} from "@tabler/icons-react"

import { NavMain } from "@/components/nav-main"
import { NavSecondary } from "@/components/nav-secondary"
import { NavUser } from "@/components/nav-user"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

const navMain = [
  {
    title: "Dashboard",
    url: "/dashboard",
    icon: IconLayoutDashboard,
  },
  {
    title: "Members",
    url: "/members",
    icon: IconUsers,
  },
  {
    title: "Small Groups",
    url: "/small-groups",
    icon: IconUsersGroup,
  },
  {
    title: "Ministries",
    url: "/ministries",
    icon: IconBuilding,
  },
  {
    title: "Events",
    url: "/events",
    icon: IconCalendar,
  },
  {
    title: "Volunteers",
    url: "/volunteers",
    icon: IconHeart,
  },
]

const navSecondary = [
  {
    title: "Settings",
    url: "/settings",
    icon: IconSettings,
  },
  {
    title: "Help",
    url: "#",
    icon: IconHelp,
  },
]

type AppSidebarProps = React.ComponentProps<typeof Sidebar> & {
  user: {
    name: string
    email: string
    avatar: string
  }
}

export function AppSidebar({ user, ...props }: AppSidebarProps) {
  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              className="data-[slot=sidebar-menu-button]:p-1.5!"
            >
              <a href="/">
                <IconBuildingChurch className="size-5!" />
                <span className="text-base font-semibold">Churchie</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={navMain} />
        <NavSecondary items={navSecondary} className="mt-auto" />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
    </Sidebar>
  )
}
