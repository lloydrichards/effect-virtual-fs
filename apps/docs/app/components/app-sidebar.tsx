import { Package } from "lucide-react"
import { Link, useLocation } from "react-router"
import { GithubIcon } from "~/components/icons"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar
} from "~/components/ui/sidebar"
import { navigation } from "~/nav.config"

export function AppSidebar() {
  const location = useLocation()
  const { isMobile, setOpenMobile } = useSidebar()
  const closeMobileSidebar = () => {
    if (isMobile) setOpenMobile(false)
  }

  return (
    <Sidebar>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link to="/" onClick={closeMobileSidebar} />}
              className="h-11 md:h-8"
            >
              <span className="font-heading text-base font-semibold tracking-[-0.035em]">
                effect-virtual-fs
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {navigation.map((section) => (
          <SidebarGroup key={section.title}>
            <SidebarGroupLabel>{section.title}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {section.items.map((item) => (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      render={
                        <Link
                          to={item.href}
                          onClick={closeMobileSidebar}
                          aria-current={location.pathname === item.href ? "page" : undefined}
                        />
                      }
                      isActive={location.pathname === item.href}
                      className="h-11 md:h-8"
                    >
                      {item.label}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter>
        <div className="flex items-center justify-between py-2">
          <a
            href="https://lloydrichards.dev"
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-h-10 items-center rounded-md text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            lloydrichards.dev
          </a>
          <div className="flex items-center gap-3">
            <a
              href="https://github.com/lloydrichards/effect-virtual-fs"
              target="_blank"
              rel="noopener noreferrer"
              className="flex size-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:size-8"
              title="GitHub"
            >
              <GithubIcon className="size-4" />
            </a>
            <a
              href="https://www.npmjs.com/search?q=%40effect-vfs"
              target="_blank"
              rel="noopener noreferrer"
              className="flex size-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:size-8"
              title="npm packages"
            >
              <Package className="size-4" />
            </a>
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
