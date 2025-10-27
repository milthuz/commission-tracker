# Commission Tracker - Cluster POS Branding

## 🎨 Customization Guide

This branded version has been customized for Cluster POS with modern, professional design aesthetics.

---

## Color Palette

### Primary Colors
- **Cluster Blue**: `#2563EB` (Primary brand color)
  - Used for: Primary buttons, links, main accents
  - Psychology: Trust, reliability, technology

- **Cluster Green**: `#059669` (Secondary brand color)
  - Used for: Success states, charts, confirmation actions
  - Psychology: Growth, health, sustainability

### Supporting Colors
- **Slate Grays**: `#0f172a` to `#f1f5f9`
  - Used for: Backgrounds, borders, text hierarchy
  - Modern, clean aesthetic

### Chart Colors
```javascript
CHART_COLORS = [
  '#2563EB' // Cluster Blue
  '#059669' // Cluster Green
  '#0EA5E9' // Cyan
  '#7C3AED' // Purple
  '#DB2777' // Pink
];
```

---

## Typography

**Font Stack**: Uses system fonts (San Francisco, Segoe UI, Roboto)

### Font Weights
- `font-bold` - Page titles (24px)
- `font-semibold` - Section headers (18px)
- `font-medium` - Labels, buttons
- `regular` - Body text

---

## Component Styling

### Header
- Clean white background with subtle border
- Logo area with gradient blue square
- "Cluster Sales Commission" branding
- Logout button in slate

### Login Screen
- Gradient background (slate to blue)
- White card with blue top border
- Cluster logo with TrendingUp icon
- Demo buttons with blue/green gradients

### Stats Cards
- Gradient backgrounds matching brand colors
- Large readable numbers
- Icon badges with color-matched gradients
- Hover effects for interactivity

### Charts
- Blue bars and green lines
- Subtle grid styling
- Rounded corners for modern feel
- Proper spacing and typography

### Data Tables
- Clean striped rows
- Slate borders and backgrounds
- Color-coded commissions (blue text)
- Expandable details sections

---

## Customization Points

### 1. Change Brand Colors

**File**: `commission-tracker-cluster-branded.jsx`

Find and replace:
```javascript
// Line: const CLUSTER_BLUE = '#2563EB'
const CLUSTER_BLUE = '#YOUR_COLOR';

// Line: const CLUSTER_GREEN = '#059669'
const CLUSTER_GREEN = '#YOUR_COLOR';
```

### 2. Update Logo

Replace in header section:
```javascript
// OLD
<TrendingUp className="w-6 h-6 text-white" />

// NEW
<img src="/your-logo.png" className="w-6 h-6" />
```

### 3. Change Company Name

Replace all instances of:
```javascript
"Cluster Sales Commission" → "Your Company Name"
"Cluster POS" → "Your Company"
```

### 4. Update Color Schemes in Stats Cards

```javascript
// Current
<StatCard
  bgGradient="from-blue-500 to-blue-600"
  bgLight="bg-blue-50"
  textColor="text-blue-600"
/>

// Change to match your colors (using Tailwind classes)
```

---

## Color Implementation

### Gradients Used
```css
/* Blue Gradient */
from-blue-600 to-blue-700
from-blue-500 to-blue-600

/* Green Gradient */
from-green-500 to-green-600
from-green-50 to-green-100

/* Charts */
#2563EB (bar chart)
#059669 (line chart)
```

### Hover States
- Buttons: Darker shade of primary color
- Cards: Subtle shadow on hover
- Links: Color darkening + underline

---

## Tailwind CSS Classes Used

### Color Classes (Replace for Custom Branding)
- `bg-blue-600` → Primary button background
- `text-blue-600` → Primary text color
- `hover:bg-blue-700` → Hover states
- `border-blue-200` → Subtle borders
- `bg-blue-50` → Light backgrounds

### Spacing
- `p-6` (24px padding)
- `p-4` (16px padding)
- `gap-6` (24px gap)
- `mb-8` (32px margin bottom)

### Shadows
- `shadow-sm` - Subtle
- `shadow-md` - Medium
- `shadow-lg` - Large

---

## Design System

### Card Design
```jsx
<div className="bg-white rounded-lg shadow-sm border border-slate-200 p-6">
  {/* Content */}
</div>
```

### Button Design
```jsx
<button className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium transition">
  {/* Button text */}
</button>
```

### Input Design
```jsx
<input className="px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500" />
```

---

## Responsive Design

- **Mobile** (< 640px): Single column layout
- **Tablet** (640-1024px): 2 columns
- **Desktop** (> 1024px): 4 columns for stats, 2 columns for charts

Use `grid-cols-1 md:grid-cols-4 lg:grid-cols-4` pattern

---

## Brand Guidelines Applied

✅ **Modern Tech Aesthetic**
- Clean, minimal design
- Generous whitespace
- Professional typography

✅ **Restaurant/Hospitality Focus**
- User-friendly interface
- Quick scanning (for busy environments)
- High contrast for readability

✅ **Cluster POS Values**
- Reliability (consistent colors)
- Simplicity (clear hierarchy)
- Growth (upward trending icons)

---

## Files Included

1. `commission-tracker-cluster-branded.jsx` - Main branded component
2. `commission-tracker.jsx` - Original generic version (for reference)

---

## Implementation Steps

1. Replace the original `commission-tracker.jsx` with `commission-tracker-cluster-branded.jsx`
2. Update your logo path if needed
3. Adjust colors if you have specific brand hex codes
4. Test on mobile and desktop
5. Customize any text (company names, etc.)

---

## Further Customization

### Add Your Logo
```jsx
// In header section, replace the icon with:
<img 
  src="/path/to/cluster-logo.png" 
  className="w-10 h-10 mr-3 object-contain"
  alt="Cluster POS"
/>
```

### Change Gradient Theme
Edit the `bgGradient` props in StatCard components:
```jsx
// From
bgGradient="from-blue-500 to-blue-600"

// To any Tailwind gradient:
bgGradient="from-indigo-500 to-purple-600"
```

### Customize Chart Colors
```javascript
const CHART_COLORS = [
  '#your-color-1',
  '#your-color-2',
  '#your-color-3',
];
```

---

## Color Psychology for Restaurant Tech

- **Blue** - Trust, reliability, professional
- **Green** - Growth, success, sustainability
- **Slate/Gray** - Modern, neutral, clean
- **White** - Clarity, transparency, simplicity

These colors work well for restaurant software because they convey:
✓ Reliability (restaurant owners need to trust the system)
✓ Growth (shows business improvement)
✓ Modernity (competitive advantage)
✓ Simplicity (fast learning curve for staff)

---

## CSS Classes Reference

### Backgrounds
- `bg-white` - Cards
- `bg-slate-50` - Subtle backgrounds
- `bg-blue-50` - Light primary
- `bg-green-50` - Light secondary

### Text
- `text-slate-900` - Headers
- `text-slate-700` - Labels
- `text-slate-600` - Secondary text
- `text-blue-600` - Primary accent

### Borders
- `border-slate-200` - Standard borders
- `border-blue-200` - Primary accents
- `border-t-4 border-blue-600` - Top accent (login card)

### Interactive
- `hover:bg-blue-700` - Button hover
- `hover:shadow-md` - Card hover
- `focus:ring-2 focus:ring-blue-500` - Input focus

---

## Testing Checklist

- [ ] Logo displays correctly
- [ ] Colors match brand guidelines
- [ ] Mobile responsive (test on phone)
- [ ] Buttons are clickable
- [ ] Charts render properly
- [ ] Text is readable (contrast check)
- [ ] Hover states work
- [ ] Login demo works
- [ ] Logout works
- [ ] Table is scrollable on mobile

---

**Version**: 1.0 Cluster Branded  
**Last Updated**: October 2025  
**Status**: Ready to Deploy

---

## Need Help?

1. Check original SETUP_GUIDE.md for implementation
2. Review Tailwind documentation: https://tailwindcss.com
3. Verify color hex codes at: https://www.color-hex.com

Happy branding! 🎨
