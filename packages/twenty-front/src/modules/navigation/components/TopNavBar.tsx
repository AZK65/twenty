import { styled } from '@linaria/react';
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { themeCssVariables } from 'twenty-ui/theme-constants';

type NavLeaf = { label: string; to: string };
type NavItem = { label: string; to?: string; children?: NavLeaf[] };

// App Leads / Checkout Clients / Payments Clients point at specific views.
const APP_LEADS_VIEW = 'a9197fb8-2e3a-4965-adcb-0084deaa5ce6';
const CHECKOUT_CLIENTS_VIEW = 'c1ec0000-0000-4000-8000-000000000001';
const PAYMENTS_CLIENTS_VIEW = 'c1ec0000-0000-4000-8000-000000000002';

const NAV_ITEMS: NavItem[] = [
  { label: 'Home', to: '/home' },
  {
    label: 'Sales',
    children: [
      { label: 'Leads', to: '/objects/leads' },
      { label: 'App Leads', to: `/objects/leads?viewId=${APP_LEADS_VIEW}` },
      { label: 'Opportunities', to: '/objects/opportunities' },
      {
        label: 'Checkout Clients',
        to: `/objects/people?viewId=${CHECKOUT_CLIENTS_VIEW}`,
      },
      {
        label: 'Payments Clients',
        to: `/objects/people?viewId=${PAYMENTS_CLIENTS_VIEW}`,
      },
      { label: 'Lost', to: '/objects/losses' },
      { label: 'Workflows', to: '/objects/workflows' },
    ],
  },
  {
    label: 'Tracking',
    children: [{ label: 'Sales Deals', to: '/sales-deals' }],
  },
  { label: 'Tools', children: [{ label: 'Cheat Sheet', to: '/cheat-sheet' }] },
  { label: 'Tasks', to: '/objects/tasks' },
  { label: 'Note Pad', to: '/notepad' },
];

const StyledBar = styled.nav`
  align-items: center;
  background: ${themeCssVariables.background.primary};
  border-bottom: 1px solid ${themeCssVariables.border.color.light};
  display: flex;
  flex-shrink: 0;
  gap: 4px;
  height: 40px;
  padding: 0 12px;
  z-index: 5;
`;

const StyledItem = styled.button<{ active: boolean }>`
  background: ${({ active }) =>
    active ? themeCssVariables.background.tertiary : 'transparent'};
  border: none;
  border-radius: 6px;
  color: ${themeCssVariables.font.color.primary};
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  height: 28px;
  padding: 0 12px;
`;

const StyledDropdownWrapper = styled.div`
  position: relative;
`;

const StyledMenu = styled.div`
  background: ${themeCssVariables.background.primary};
  border: 1px solid ${themeCssVariables.border.color.medium};
  border-radius: 8px;
  box-shadow: ${themeCssVariables.boxShadow.strong};
  display: flex;
  flex-direction: column;
  left: 0;
  min-width: 180px;
  padding: 4px;
  position: absolute;
  top: 34px;
  z-index: 10;
`;

const StyledMenuItem = styled.button`
  background: transparent;
  border: none;
  border-radius: 4px;
  color: ${themeCssVariables.font.color.primary};
  cursor: pointer;
  font-size: 14px;
  padding: 8px 10px;
  text-align: left;

  &:hover {
    background: ${themeCssVariables.background.tertiary};
  }
`;

const StyledBackdrop = styled.div`
  inset: 0;
  position: fixed;
  z-index: 4;
`;

export const TopNavBar = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  const go = (to: string) => {
    setOpenMenu(null);
    navigate(to);
  };

  const isActive = (item: NavItem) => {
    if (item.to !== undefined) {
      return location.pathname + location.search === item.to;
    }

    return (item.children ?? []).some(
      (child) => location.pathname + location.search === child.to,
    );
  };

  return (
    <>
      {openMenu !== null && (
        <StyledBackdrop onClick={() => setOpenMenu(null)} />
      )}
      <StyledBar>
        {NAV_ITEMS.map((item) =>
          item.children === undefined ? (
            <StyledItem
              key={item.label}
              active={isActive(item)}
              onClick={() => go(item.to ?? '/')}
            >
              {item.label}
            </StyledItem>
          ) : (
            <StyledDropdownWrapper key={item.label}>
              <StyledItem
                active={isActive(item)}
                onClick={() =>
                  setOpenMenu(openMenu === item.label ? null : item.label)
                }
              >
                {item.label} ▾
              </StyledItem>
              {openMenu === item.label && (
                <StyledMenu>
                  {item.children.map((child) => (
                    <StyledMenuItem
                      key={child.label}
                      onClick={() => go(child.to)}
                    >
                      {child.label}
                    </StyledMenuItem>
                  ))}
                </StyledMenu>
              )}
            </StyledDropdownWrapper>
          ),
        )}
      </StyledBar>
    </>
  );
};
