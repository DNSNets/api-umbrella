# Read about factories at https://github.com/thoughtbot/factory_girl

FactoryGirl.define do
  factory :api_sub_setting, :class => 'Api::SubSettings' do
    http_method "POST"
    regex ".*"
  end
end
