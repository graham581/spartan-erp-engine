/* =====================================================================
 * Generated DocType interfaces — Selling slice  (DO NOT EDIT)
 * Source of truth: ERPNext DocType JSON. Regenerate: npm run generate
 * ===================================================================== */

export interface BaseDoc {
  name: string;
  owner?: string;
  creation?: string;
  modified?: string;
  modified_by?: string;
  docstatus?: 0 | 1 | 2;
  idx?: number;
}

export interface ChildDoc extends BaseDoc {
  parent?: string;
  parenttype?: string;
  parentfield?: string;
}

/** Currency — generated from C:/Users/parrg/Documents/spartan-erp-engine/src/generator/synthetic/currency.json */
export interface Currency extends BaseDoc {
  currency_name: string;
  symbol?: string;
  enabled?: boolean;
  fraction?: string;
  fraction_units?: number;
  smallest_currency_fraction_value?: number;
  number_format?: string;
}

/** UOM — generated from C:/Users/parrg/Documents/erpnext-develop/erpnext-develop/erpnext/setup/doctype/uom/uom.json */
export interface UOM extends BaseDoc {
  uom_name: string;
  must_be_whole_number?: boolean;
  enabled?: boolean;
  symbol?: string;
  common_code?: string;
  description?: string;
  category?: string; // -> UOM Category
}

/** Company — generated from C:/Users/parrg/Documents/erpnext-develop/erpnext-develop/erpnext/setup/doctype/company/company.json */
export interface Company extends BaseDoc {
  company_name: string;
  abbr: string;
  is_group?: boolean;
  default_finance_book?: string; // -> Finance Book
  domain?: string;
  parent_company?: string; // -> Company
  company_logo?: string;
  company_description?: string;
  sales_monthly_history?: string;
  transactions_annual_history?: string;
  monthly_sales_target?: number;
  total_monthly_sales?: number;
  default_currency: string; // -> Currency
  default_letter_head?: string; // -> Letter Head
  default_holiday_list?: string; // -> Holiday List
  default_warehouse_for_sales_return?: string; // -> Warehouse
  country: string; // -> Country
  create_chart_of_accounts_based_on?: 'Standard Template' | 'Existing Company' | '';
  chart_of_accounts?: string;
  existing_company?: string; // -> Company
  tax_id?: string;
  date_of_establishment?: string;
  default_bank_account?: string; // -> Account
  default_cash_account?: string; // -> Account
  default_receivable_account?: string; // -> Account
  round_off_account?: string; // -> Account
  round_off_cost_center?: string; // -> Cost Center
  write_off_account?: string; // -> Account
  exchange_gain_loss_account?: string; // -> Account
  unrealized_exchange_gain_loss_account?: string; // -> Account
  allow_account_creation_against_child_company?: boolean;
  default_payable_account?: string; // -> Account
  default_expense_account?: string; // -> Account
  default_income_account?: string; // -> Account
  default_deferred_revenue_account?: string; // -> Account
  default_deferred_expense_account?: string; // -> Account
  cost_center?: string; // -> Cost Center
  credit_limit?: number;
  payment_terms?: string; // -> Payment Terms Template
  enable_perpetual_inventory?: boolean;
  default_inventory_account?: string; // -> Account
  stock_adjustment_account?: string; // -> Account
  stock_received_but_not_billed?: string; // -> Account
  accumulated_depreciation_account?: string; // -> Account
  depreciation_expense_account?: string; // -> Account
  series_for_depreciation_entry?: string;
  disposal_account?: string; // -> Account
  depreciation_cost_center?: string; // -> Cost Center
  capital_work_in_progress_account?: string; // -> Account
  asset_received_but_not_billed?: string; // -> Account
  exception_budget_approver_role?: string; // -> Role
  date_of_incorporation?: string;
  date_of_commencement?: string;
  phone_no?: string;
  fax?: string;
  email?: string;
  website?: string;
  registration_details?: string;
  lft?: number;
  rgt?: number;
  old_parent?: string;
  default_selling_terms?: string; // -> Terms and Conditions
  default_buying_terms?: string; // -> Terms and Conditions
  default_in_transit_warehouse?: string; // -> Warehouse
  unrealized_profit_loss_account?: string; // -> Account
  default_discount_account?: string; // -> Account
  enable_provisional_accounting_for_non_stock_items?: boolean;
  default_provisional_account?: string; // -> Account
  default_advance_received_account?: string; // -> Account
  default_advance_paid_account?: string; // -> Account
  book_advance_payments_in_separate_party_account?: boolean;
  auto_exchange_rate_revaluation?: boolean;
  auto_err_frequency?: 'Daily' | 'Weekly' | 'Monthly';
  submit_err_jv?: boolean;
  reconcile_on_advance_payment_date?: boolean;
  default_operating_cost_account?: string; // -> Account
  round_off_for_opening?: string; // -> Account
  reconciliation_takes_effect_on?: 'Advance Payment Date' | 'Oldest Of Invoice Or Advance' | 'Reconciliation Date';
  reporting_currency?: string; // -> Currency
  purchase_expense_account?: string; // -> Account
  purchase_expense_contra_account?: string; // -> Account
  service_expense_account?: string; // -> Account
  enable_item_wise_inventory_account?: boolean;
  valuation_method: 'FIFO' | 'Moving Average' | 'LIFO';
  default_wip_warehouse?: string; // -> Warehouse
  default_fg_warehouse?: string; // -> Warehouse
  default_scrap_warehouse?: string; // -> Warehouse
  default_sales_contact?: string; // -> Contact
  accounts_frozen_till_date?: string;
  role_allowed_for_frozen_entries?: string; // -> Role
  default_letter_head_report?: string; // -> Letter Head
  disable_sdbnb_in_sr?: boolean;
  stock_delivered_but_not_billed?: string; // -> Account
}

/** Customer — generated from C:/Users/parrg/Documents/erpnext-develop/erpnext-develop/erpnext/selling/doctype/customer/customer.json */
export interface Customer extends BaseDoc {
  naming_series?: 'CUST-.YYYY.-';
  customer_name: string;
  gender?: string; // -> Gender
  customer_type: 'Company' | 'Individual' | 'Partnership';
  default_bank_account?: string; // -> Bank Account
  lead_name?: string; // -> Lead
  image?: string;
  account_manager?: string; // -> User
  customer_group?: string; // -> Customer Group
  territory?: string; // -> Territory
  tax_id?: string;
  tax_category?: string; // -> Tax Category
  disabled?: boolean;
  is_internal_customer?: boolean;
  represents_company?: string; // -> Company
  default_currency?: string; // -> Currency
  default_price_list?: string; // -> Price List
  language?: string; // -> Language
  website?: string;
  customer_primary_contact?: string; // -> Contact
  mobile_no?: string;
  email_id?: string;
  customer_primary_address?: string; // -> Address
  primary_address?: string;
  payment_terms?: string; // -> Payment Terms Template
  customer_details?: string;
  market_segment?: string; // -> Market Segment
  industry?: string; // -> Industry Type
  is_frozen?: boolean;
  loyalty_program?: string; // -> Loyalty Program
  loyalty_program_tier?: string;
  default_sales_partner?: string; // -> Sales Partner
  default_commission_rate?: number;
  customer_pos_id?: string;
  so_required?: boolean;
  dn_required?: boolean;
  tax_withholding_category?: string; // -> Tax Withholding Category
  opportunity_name?: string; // -> Opportunity
  prospect_name?: string; // -> Prospect
  first_name?: string;
  last_name?: string;
  tax_withholding_group?: string; // -> Tax Withholding Group
}

/** Item — generated from C:/Users/parrg/Documents/erpnext-develop/erpnext-develop/erpnext/stock/doctype/item/item.json */
export interface Item extends BaseDoc {
  naming_series?: 'STO-ITEM-.YYYY.-';
  item_code: string;
  variant_of?: string; // -> Item
  item_name?: string;
  item_group: string; // -> Item Group
  stock_uom: string; // -> UOM
  disabled?: boolean;
  allow_alternative_item?: boolean;
  is_stock_item?: boolean;
  include_item_in_manufacturing?: boolean;
  opening_stock?: number;
  valuation_rate?: number;
  standard_rate?: number;
  is_fixed_asset?: boolean;
  asset_category?: string; // -> Asset Category
  asset_naming_series?: string;
  image?: string;
  brand?: string; // -> Brand
  description?: string;
  shelf_life_in_days?: number;
  end_of_life?: string;
  default_material_request_type?: 'Purchase' | 'Material Transfer' | 'Material Issue' | 'Manufacture' | 'Customer Provided';
  valuation_method?: 'FIFO' | 'Moving Average' | 'LIFO' | '';
  warranty_period?: string;
  weight_per_unit?: number;
  weight_uom?: string; // -> UOM
  has_batch_no?: boolean;
  create_new_batch?: boolean;
  batch_number_series?: string;
  has_expiry_date?: boolean;
  retain_sample?: boolean;
  sample_quantity?: number;
  has_serial_no?: boolean;
  serial_no_series?: string;
  has_variants?: boolean;
  variant_based_on?: 'Item Attribute' | 'Manufacturer';
  is_purchase_item?: boolean;
  purchase_uom?: string; // -> UOM
  min_order_qty?: number;
  safety_stock?: number;
  lead_time_days?: number;
  last_purchase_rate?: number;
  is_customer_provided_item?: boolean;
  delivered_by_supplier?: boolean;
  country_of_origin?: string; // -> Country
  customs_tariff_number?: string; // -> Customs Tariff Number
  sales_uom?: string; // -> UOM
  is_sales_item?: boolean;
  max_discount?: number;
  enable_deferred_revenue?: boolean;
  no_of_months?: number;
  enable_deferred_expense?: boolean;
  no_of_months_exp?: number;
  inspection_required_before_purchase?: boolean;
  inspection_required_before_delivery?: boolean;
  quality_inspection_template?: string; // -> Quality Inspection Template
  default_bom?: string; // -> BOM
  is_sub_contracted_item?: boolean;
  customer_code?: string;
  total_projected_qty?: number;
  over_delivery_receipt_allowance?: number;
  over_billing_allowance?: number;
  auto_create_assets?: boolean;
  default_item_manufacturer?: string; // -> Manufacturer
  default_manufacturer_part_no?: string;
  grant_commission?: boolean;
  is_grouped_asset?: boolean;
  allow_negative_stock?: boolean;
  production_capacity?: number;
  purchase_tax_withholding_category?: string; // -> Tax Withholding Category
  sales_tax_withholding_category?: string; // -> Tax Withholding Category
}

/** Sales Order — generated from C:/Users/parrg/Documents/erpnext-develop/erpnext-develop/erpnext/selling/doctype/sales_order/sales_order.json */
export interface SalesOrder extends BaseDoc {
  naming_series: 'SAL-ORD-.YYYY.-';
  customer: string; // -> Customer
  customer_name?: string;
  order_type: 'Sales' | 'Maintenance' | 'Shopping Cart' | '';
  amended_from?: string; // -> Sales Order
  company: string; // -> Company
  transaction_date: string;
  delivery_date?: string;
  po_no?: string;
  po_date?: string;
  tax_id?: string;
  customer_address?: string; // -> Address
  address_display?: string;
  contact_person?: string; // -> Contact
  contact_display?: string;
  contact_mobile?: string;
  contact_email?: string;
  company_address_display?: string;
  company_address?: string; // -> Address
  shipping_address_name?: string; // -> Address
  shipping_address?: string;
  customer_group?: string; // -> Customer Group
  territory?: string; // -> Territory
  currency: string; // -> Currency
  conversion_rate: number;
  selling_price_list: string; // -> Price List
  price_list_currency: string; // -> Currency
  plc_conversion_rate: number;
  ignore_pricing_rule?: boolean;
  set_warehouse?: string; // -> Warehouse
  scan_barcode?: string;
  items?: SalesOrderItem[];
  total_qty?: number;
  base_total?: number;
  base_net_total?: number;
  total?: number;
  net_total?: number;
  total_net_weight?: number;
  tax_category?: string; // -> Tax Category
  shipping_rule?: string; // -> Shipping Rule
  taxes_and_charges?: string; // -> Sales Taxes and Charges Template
  other_charges_calculation?: string;
  base_total_taxes_and_charges?: number;
  total_taxes_and_charges?: number;
  loyalty_points?: number;
  loyalty_amount?: number;
  coupon_code?: string; // -> Coupon Code
  apply_discount_on?: 'Grand Total' | 'Net Total' | '';
  base_discount_amount?: number;
  additional_discount_percentage?: number;
  discount_amount?: number;
  base_grand_total?: number;
  base_rounding_adjustment?: number;
  base_rounded_total?: number;
  base_in_words?: string;
  grand_total?: number;
  rounding_adjustment?: number;
  rounded_total?: number;
  in_words?: string;
  advance_paid?: number;
  payment_terms_template?: string; // -> Payment Terms Template
  tc_name?: string; // -> Terms and Conditions
  terms?: string;
  inter_company_order_reference?: string; // -> Purchase Order
  project?: string; // -> Project
  party_account_currency?: string; // -> Currency
  language?: string; // -> Language
  letter_head?: string; // -> Letter Head
  select_print_heading?: string; // -> Print Heading
  group_same_items?: boolean;
  status: 'Draft' | 'On Hold' | 'To Pay' | 'To Deliver and Bill' | 'To Bill' | 'To Deliver' | 'Completed' | 'Cancelled' | 'Closed' | '';
  delivery_status?: 'Not Delivered' | 'Fully Delivered' | 'Partly Delivered' | 'Closed' | 'Not Applicable';
  per_delivered?: number;
  per_billed?: number;
  billing_status?: 'Not Billed' | 'Fully Billed' | 'Partly Billed' | 'Closed';
  sales_partner?: string; // -> Sales Partner
  commission_rate?: number;
  total_commission?: number;
  from_date?: string;
  to_date?: string;
  auto_repeat?: string; // -> Auto Repeat
  contact_phone?: string;
  skip_delivery_note?: boolean;
  is_internal_customer?: boolean;
  represents_company?: string; // -> Company
  disable_rounded_total?: boolean;
  dispatch_address_name?: string; // -> Address
  dispatch_address?: string;
  amount_eligible_for_commission?: number;
  per_picked?: number;
  cost_center?: string; // -> Cost Center
  incoterm?: string; // -> Incoterm
  named_place?: string;
  reserve_stock?: boolean;
  advance_payment_status?: 'Not Requested' | 'Requested' | 'Partially Paid' | 'Fully Paid';
  utm_medium?: string; // -> UTM Medium
  utm_content?: string;
  utm_source?: string; // -> UTM Source
  utm_campaign?: string; // -> UTM Campaign
  company_contact_person?: string; // -> Contact
  has_unit_price_items?: boolean;
  last_scanned_warehouse?: string;
  is_subcontracted?: boolean;
  transaction_time?: string;
  ignore_default_payment_terms_template?: boolean;
  title?: string;
}

/** Sales Order Item — generated from C:/Users/parrg/Documents/erpnext-develop/erpnext-develop/erpnext/selling/doctype/sales_order_item/sales_order_item.json */
export interface SalesOrderItem extends ChildDoc {
  item_code: string; // -> Item
  is_product_bundle?: boolean;
  product_bundle?: string; // -> Product Bundle
  customer_item_code?: string;
  ensure_delivery_based_on_produced_serial_no?: boolean;
  item_name: string;
  description?: string;
  delivery_date?: string;
  image?: string;
  image_view?: string;
  qty: number;
  stock_uom?: string; // -> UOM
  uom: string; // -> UOM
  conversion_factor: number;
  stock_qty?: number;
  price_list_rate?: number;
  base_price_list_rate?: number;
  margin_type?: 'Percentage' | 'Amount' | '';
  margin_rate_or_amount?: number;
  rate_with_margin?: number;
  discount_percentage?: number;
  discount_amount?: number;
  base_rate_with_margin?: number;
  rate?: number;
  amount?: number;
  base_rate?: number;
  base_amount?: number;
  pricing_rules?: string;
  is_free_item?: boolean;
  net_rate?: number;
  net_amount?: number;
  base_net_rate?: number;
  base_net_amount?: number;
  delivered_by_supplier?: boolean;
  supplier?: string; // -> Supplier
  weight_per_unit?: number;
  total_weight?: number;
  weight_uom?: string; // -> UOM
  warehouse?: string; // -> Warehouse
  target_warehouse?: string; // -> Warehouse
  prevdoc_docname?: string; // -> Quotation
  brand?: string; // -> Brand
  item_group?: string; // -> Item Group
  billed_amt?: number;
  valuation_rate?: number;
  gross_profit?: number;
  blanket_order?: string; // -> Blanket Order
  blanket_order_rate?: number;
  projected_qty?: number;
  actual_qty?: number;
  ordered_qty?: number;
  delivered_qty?: number;
  work_order_qty?: number;
  returned_qty?: number;
  item_tax_template?: string; // -> Item Tax Template
  page_break?: boolean;
  planned_qty?: number;
  produced_qty?: number;
  item_tax_rate?: string;
  transaction_date?: string;
  additional_notes?: string;
  against_blanket_order?: boolean;
  bom_no?: string; // -> BOM
  stock_uom_rate?: number;
  grant_commission?: boolean;
  picked_qty?: number;
  purchase_order?: string; // -> Purchase Order
  purchase_order_item?: string;
  quotation_item?: string;
  material_request?: string; // -> Material Request
  material_request_item?: string;
  reserve_stock?: boolean;
  stock_reserved_qty?: number;
  production_plan_qty?: number;
  is_stock_item?: boolean;
  distributed_discount_amount?: number;
  company_total_stock?: number;
  cost_center?: string; // -> Cost Center
  project?: string; // -> Project
  subcontracted_qty?: number;
  fg_item?: string; // -> Item
  fg_item_qty?: number;
  requested_qty?: number;
}

/** Window — generated from C:/Users/parrg/Documents/spartan-erp-engine/src/generator/synthetic/window.json */
export interface Window extends BaseDoc {
  sales_order: string; // -> Sales Order
  sales_order_item?: string; // -> Sales Order Item
  item_code: string; // -> Item
  window_label?: string;
  location?: string;
  window_type: 'Awning' | 'Sliding' | 'Double Hung' | 'Casement' | 'Fixed' | 'Bifold' | 'French Door' | 'Sliding Door';
  qty?: number;
  width_mm: number;
  height_mm: number;
  opening_direction?: 'Left' | 'Right' | 'Up' | 'Down' | 'Fixed' | '';
  frame_material?: 'Aluminium' | 'uPVC' | 'Timber';
  frame_colour?: string;
  glass_type?: string; // -> Glass Spec
  is_double_glazed?: boolean;
  is_safety_glass?: boolean;
  reveal_mm?: number;
  handle_height_mm?: number;
  flyscreen?: boolean;
  notes?: string;
}
