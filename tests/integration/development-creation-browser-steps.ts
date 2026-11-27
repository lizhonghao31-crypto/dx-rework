import type {Page} from "playwright-core";

export async function chooseDevelopmentCreation(
  page:Page,kind:"纯开发"|"预下单"|"已确认订单",garment:"上衣"|"裤子"="上衣",rush=false,
) {
  const dialog=page.getByRole("dialog",{name:"请选择创建类型"});
  await dialog.getByRole("button",{name:kind,exact:true}).click();
  // Astryx includes its required-field marker in the accessible name.
  await dialog.getByRole("combobox",{name:/^衣类/}).click();
  await page.getByRole("option",{name:garment==='上衣'?/^(上装|上衣)$/:/^(下装|裤子)$/}).click();
  await dialog.getByRole("combobox",{name:/^急单/}).click();
  await page.getByRole("option",{name:rush?"是":"否",exact:true}).click();
  await dialog.getByRole("button",{name:"进入建单",exact:true}).click();
  await dialog.waitFor({state:"hidden"});
}
